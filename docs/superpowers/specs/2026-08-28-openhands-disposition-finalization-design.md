# OpenHands Disposition Finalization Design

## Context

The `openhands_gateway` adapter accepts a bounded OpenHands result only after validating its protocol, task/run/agent correlation, repository, base ref, commit, test evidence, and result size. A successful adapter process currently returns `exitCode: 0` and the validated result JSON, but it does not update the assigned Paperclip issue. Paperclip therefore detects `successful_run_missing_issue_disposition`, schedules one corrective run, and eventually blocks the issue even though OpenHands completed valid work.

The production VTH-20 canary reproduced this behavior: two sequential gateway attempts completed with valid `no_change` evidence for the expected repository and baseline commit, while Paperclip escalated the issue because neither run recorded a final disposition.

## Accepted Approach

Finalize the issue inside the Paperclip-hosted OpenHands adapter after—and only after—the adapter validates a correlated `completed` gateway result.

The adapter will use Paperclip's existing per-run `context.authToken` and `PAPERCLIP_API_URL` to send an authenticated `PATCH /api/issues/{issueId}` request from the Paperclip server. It will set `status` to `done` and add a fixed-format bounded comment containing only validated, non-secret evidence fields. The token remains inside Paperclip and is never placed in the OpenHands dispatch, WebSocket frame, Canvas prompt, process logs, result JSON, or coding VM.

This approach was selected over:

1. Extending the generic adapter result contract and heartbeat core to apply dispositions, which changes every adapter and is unnecessary for the OpenHands integration.
2. Giving OpenHands direct Paperclip credentials, which would broaden the Canvas trust boundary and violate the credential-isolation requirement.

## Components and Data Flow

### Disposition helper

A focused helper in the OpenHands adapter module will:

- accept the issue ID, validated completion evidence, per-run auth token, configured Paperclip API URL, and an injectable HTTP implementation for tests;
- require a non-empty per-run token and a valid HTTP(S) Paperclip API base URL;
- build the fixed endpoint `/api/issues/{percent-encoded issueId}` without accepting a caller-controlled path;
- send exactly one bounded JSON patch containing `status: "done"` and a deterministic comment;
- use `Authorization: Bearer <per-run token>` and `Content-Type: application/json` without logging either the token or request body;
- reject redirects, bound the request deadline, and bound the response body before parsing it;
- accept only a successful response whose issue ID matches the dispatched task and whose status is `done`.

The comment will distinguish `no_change` from changed-work completion but will contain only fields already validated by the adapter. For `no_change`, it will state that OpenHands completed with validated no-change evidence and name the validated repository, base ref, and commit. It will not copy the free-form OpenHands summary.

### Adapter completion ordering

For a correlated `run_result` with `status: "completed"`:

1. Validate the gateway result using the existing exact evidence contract.
2. Finalize the assigned Paperclip issue to `done` using the per-run token.
3. Confirm the returned issue identity and `done` status.
4. Only then log the fixed completion message and return adapter success.

If finalization fails or is ambiguous, the adapter returns a fixed `OPENHANDS_DISPOSITION` failure. It does not claim success, expose response contents, or send a second mutation in the same run. Paperclip retains its normal retry/recovery behavior. Repeating the patch on a later run is idempotent because the intended terminal state is still `done`; the helper accepts an already-`done` response only when the issue identity matches.

Nonterminal gateway events, rejected dispatches, failure results, cancellations, timeouts, protocol errors, and indeterminate results never invoke the disposition helper.

## Configuration and Security Boundaries

- `context.authToken` is the sole authorization source. Adapter configuration cannot supply or override it.
- `PAPERCLIP_API_URL` is the sole API location source and remains server-owned runtime configuration.
- No Paperclip API token is sent to OpenHands, the Agent Canvas, CLIProxyAPI, GitHub, MCP, or the coding VM.
- The HTTP response is size-bounded before JSON parsing. Redirects, cross-origin relocation, malformed JSON, mismatched issue IDs, and non-`done` statuses fail closed.
- Error logs and adapter errors use fixed messages only. They never include credentials, response bodies, issue descriptions, prompts, or OpenHands summaries.
- Existing OpenHands gateway token handling, broker authorization, workspace policy, and GitHub authority are unchanged.

## Testing

Unit tests will prove:

- a validated `no_change` completion sends one exact `done` patch and reports success only after confirmation;
- changed-work completion uses the same disposition path;
- missing auth token or API URL returns `OPENHANDS_DISPOSITION` without an HTTP request;
- redirects, timeouts, oversized bodies, malformed JSON, non-2xx responses, mismatched issue IDs, and non-`done` responses fail closed with the fixed error;
- gateway failure, cancellation, timeout, protocol rejection, uncorrelated frames, and pre-completion states never mutate an issue;
- request authorization and response contents never appear in adapter logs;
- an already-`done` matching response is accepted as idempotent confirmation.

The existing OpenHands adapter contract suite and the relevant heartbeat disposition tests must remain green.

## Production Acceptance

After review and merge:

1. Build and deploy an immutable Paperclip release containing the adapter change; do not modify the coding VM.
2. Keep the OpenHands worker paused while deploying and confirm the gateway ledger is idle.
3. Cancel and unassign VTH-20 after preserving bounded evidence, then remove only its two validated disposable workspaces.
4. Run one fresh targeted no-change canary.
5. Require one successful OpenHands attempt, issue status `done`, ledger `active_count: 0`, valid bounded evidence, unchanged GitHub branches/issues/PRs, and disabled zero-run Canvas automations.
6. Replay the identical wake envelope and require coalescing with no additional gateway ledger row or workspace.
7. Run final production attestation and the coding-VM boundary comparison, then revoke and delete the temporary Paperclip CLI authorization file.
