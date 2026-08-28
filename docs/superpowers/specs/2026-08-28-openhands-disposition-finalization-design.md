# OpenHands Disposition Finalization Design

## Context

The `openhands_gateway` adapter accepts a bounded OpenHands result only after validating its protocol, task/run/agent correlation, repository, base ref, commit, test evidence, and result size. A successful adapter process must not return until that same authenticated heartbeat run has durably finalized its assigned Paperclip issue.

The original implementation called the generic `PATCH /api/issues/{issueId}` route and then added a comment as a separate effect. That route cannot atomically condition the mutation on the live assignee and execution locks, cannot distinguish a same-run replay from a stale caller, and can overwrite cancellation or reassignment. The built-in adapter also declared `supportsLocalAgentJwt: false`, so production heartbeats supplied no token to the client.

## Accepted Approach

Use a dedicated server operation at `POST /api/issues/{issueId}/openhands-disposition`. The route authenticates only a heartbeat-minted local-agent JWT and derives company ID, agent ID, and run ID exclusively from the verified request actor. Its body contains only strict, bounded evidence fields; it never accepts identity fields or free-form comment/summary text.

The issue service locks the live issue row and performs the status transition plus deterministic evidence-comment insert in one database transaction. The inserted comment is the receipt: it has the exact server-constructed body, authenticated agent/run attribution, and a dedicated authorization-reason marker. Row locking serializes competing dispositions, so no additional schema or migration is needed.

Because this body is validated server-constructed evidence rather than a runtime log, it bypasses the generic current-username log redaction applied by the comment helper. That preserves an exact replay key even when a repository owner matches the Paperclip host username.

This approach keeps the Paperclip token inside the server while narrowing the mutation authority to one issue, one assigned agent, and one live run.

## Transactional Invariants

The first execution succeeds only when all of these live fields match under the row lock:

- issue company equals the verified JWT company;
- issue status is `in_progress`;
- `assigneeAgentId` equals the verified JWT agent;
- `checkoutRunId` and `executionRunId` equal the verified JWT run;
- the current execution lock is present.

The transaction then:

1. constructs the deterministic bounded comment from validated outcome, repository, base ref, and commit;
2. changes the issue to `done` through the existing issue-update primitive, including normal terminal side effects and lock clearing;
3. inserts one agent-authored comment attributed to the verified run with the dedicated receipt marker;
4. commits both effects together or neither effect.

A retry succeeds only when the issue is still `done`, still assigned to the same agent, and the transaction finds the exact non-deleted receipt for that agent, run, body, and marker. It returns the existing receipt and never inserts a second comment. A different run, wrong agent/company, cancellation, reassignment, missing lock, unlocked issue, mismatched evidence, or other stale state returns the same fixed rejection and performs no mutation.

## Evidence Contract

One shared contract defines the repository and Git-ref grammar used before gateway dispatch, for completed-result validation, by the disposition client, and by the route. This prevents a completion that the adapter accepts but the disposition endpoint cannot record. Git-ref punctuation supported by the OpenHands contract includes `/` and `+` (for example `release/v1+meta`); controls, lone surrogates, normalization mismatches, unsafe repository forms, and invalid refs are rejected consistently.

The endpoint body has exactly these fields:

- `outcome`: `change` or `no_change`;
- `repository`: bounded `owner/repository` value;
- `baseRef`: bounded validated Git ref;
- `commit`: lowercase 40-character commit hash.

The adapter converts validated gateway evidence to that body. The server constructs the comment and never receives or copies the gateway `summary`.

## Adapter Ordering and Terminal Barriers

For a correlated completed result:

1. validate the full gateway result;
2. synchronously latch the common terminal guard;
3. clear the adapter deadline;
4. call the dedicated disposition endpoint using the server-only run JWT;
5. confirm the returned issue ID and `done` status;
6. emit the fixed completion log and return success.

Every terminal frame latches the same guard before any awaited logging. Once a failure, cancellation, timeout, indeterminate result, validated completion, or local deadline cancellation begins, later frames cannot start disposition. The ordering rule for a completion/deadline race is deterministic: whichever callback synchronously latches its guard first wins. A completion that starts before the deadline may finish disposition; once the deadline callback begins cancellation, later completion is ignored.

If disposition fails or is ambiguous, the adapter returns the fixed `OPENHANDS_DISPOSITION` result. It never includes response bodies, credentials, or underlying error details.

## Client Bounds and Security

- `context.authToken` is the sole authorization source; adapter configuration cannot supply or override it.
- The built-in registry enables local-agent JWT minting for `openhands_gateway`.
- `PAPERCLIP_API_URL` is the server-owned API location.
- The client rejects redirects, has an exact 10,000 ms deadline, and accepts at most 65,536 response bytes before fatal UTF-8 decoding and JSON validation.
- Deadline timers are cleared after success and every failure.
- Native-fetch behavior is covered for redirect responses and for responses whose headers arrive while the body stalls.
- The run JWT is absent from the WebSocket dispatch, gateway authorization, adapter config/context serialization, logs, and result evidence. Only the local disposition request receives it.

## Testing

Focused tests cover:

- the built-in registry capability and the real heartbeat mint/invoke boundary with a verifiable run JWT;
- token absence from gateway dispatch, logs, and returned evidence;
- real JWT middleware, the dedicated route, transaction/persistence, replay, and the successful-run recovery decision boundary;
- first execution, response-loss replay, mismatched-evidence replay, cancellation, reassignment, wrong run, wrong agent, missing locks, and transaction rollback;
- common synchronous terminal barriers and completion after local cancellation;
- shared evidence grammar, including `release/v1+meta` and unsafe/control rejection;
- exact 65,536/65,537-byte response bounds, 9,999/10,000-ms timing, timer cleanup, native redirects, and stalled response bodies;
- deterministic synchronization on a rejecting completion-log attempt without a wall-clock race.

No production, VM, GitHub, Canvas, OpenHands, coding-VM, or other remote acceptance action is part of this fix wave.
