# OpenHands Disposition Finalization — Final Fix Report

Date: 2026-08-28

Branch: `codex/openhands-disposition-finalization`

Implementation commit: `288937e16` (`fix(openhands): finalize dispositions transactionally`)

The report-only commit is recorded in the final handoff because a Git commit cannot contain its own hash.

## Outcome

The final-review wave replaces the generic issue PATCH with a dedicated authenticated operation at `POST /api/issues/:id/openhands-disposition`. A verified local-agent JWT supplies company, agent, and run identity. Under an issue-row lock, the service either commits `done` plus one exact run-attributed evidence comment in one transaction, or performs no mutation. The exact marked comment is the idempotence receipt, so no schema or migration was required.

The built-in OpenHands adapter now opts into heartbeat-minted local-agent JWT delivery. The token is consumed only by the local Paperclip disposition request; focused boundary tests prove that it does not enter OpenHands WebSocket dispatch, adapter configuration/context serialization, logs, or result evidence.

No production service, remote, VM, GitHub, Paperclip deployment, Canvas deployment, OpenHands deployment, or coding VM was contacted or mutated.

## Files and architecture

### Design and plan

- `docs/superpowers/specs/2026-08-28-openhands-disposition-finalization-design.md` documents the dedicated endpoint, actor-derived identity, row-lock transaction, exact receipt, replay/stale-state rules, shared evidence grammar, terminal ordering, bounds, and token isolation.
- `docs/superpowers/plans/2026-08-28-openhands-disposition-finalization.md` replaces the generic PATCH/deployment plan with the approved local transactional implementation and verification plan.

### Shared contract and bounded client

- `server/src/adapters/openhands-gateway/disposition-contract.ts` defines the strict evidence tuple, shared repository/Git-ref grammar, fixed rejection/receipt markers, and deterministic comment builder.
- `server/src/adapters/openhands-gateway/contract.ts` reuses the shared repository/ref validators before gateway dispatch.
- `server/src/adapters/openhands-gateway/disposition.ts` posts only `{ outcome, repository, baseRef, commit }` to the dedicated endpoint and retains redirect rejection, the 10,000 ms deadline, the 65,536-byte response bound, fatal UTF-8 decoding, fixed errors, and issue/status confirmation.
- `server/src/adapters/openhands-gateway/disposition.test.ts` pins the request contract, grammar, exact bounds/timing, timer cleanup, redirect behavior, and a native response body that stalls after headers.

### Authentication, route, transaction, and receipt

- `server/src/adapters/registry.ts` enables `supportsLocalAgentJwt` only for the built-in OpenHands gateway adapter.
- `server/src/routes/issues.ts` adds the dedicated route, accepts only `agent_jwt` actors with company/agent/run claims, and never consumes identity or free-form text from the request body.
- `server/src/services/issues.ts` locks the issue row; validates company, live status, assignee, checkout run, execution run, and execution lock; uses the existing update/comment primitives within one database transaction; and recognizes only an exact non-deleted agent/run/body/authorization-marker comment as a replay receipt.
- The deterministic receipt bypasses the generic host-username log redaction. This is narrowly opt-in for the server-built receipt so the persisted body remains an exact replay key.
- `server/src/__tests__/openhands-disposition-route.test.ts` crosses real JWT middleware, the route, embedded persistence, transaction rollback/replay, and successful-run recovery behavior.

### Terminal barriers and token boundary

- `server/src/adapters/openhands-gateway/execute.ts` uses one synchronous terminal latch before awaited logging or disposition, clears the deadline when a terminal callback wins, and rejects completion after local cancellation begins.
- `server/src/adapters/openhands-gateway/execute.test.ts` covers conflicting terminal frames, cancellation/deadline races, token-free gateway dispatch, shared grammar, and deterministic log-rejection synchronization.
- `server/src/__tests__/adapter-registry.test.ts` pins the built-in JWT capability.
- `server/src/__tests__/heartbeat-runtime-skills.test.ts` crosses the real registry/heartbeat mint-and-invoke boundary, verifies bounded JWT claims, and proves serialized inputs/logs/results do not contain the token.

## RED evidence by finding

All commands below used `PATH=/opt/homebrew/bin:$PATH` and Node `v26.4.0`.

1. **Production token wiring**

   Focused registry/heartbeat tests were added before the production capability change. The run reported 2 failures: OpenHands advertised `supportsLocalAgentJwt: false`, and the heartbeat adapter invocation captured no token. After the minimal registry change, the same two files passed 19 tests.

2. **Production-shaped authorization/persistence coverage**

   The new route integration suite was introduced before the route/service. Its initial run had 12 failures, all reaching the real server and receiving `404` for the missing endpoint. After implementation it passed 12 tests; the final suite has 13 after the exact-receipt redaction regression was added.

3. **Stale state and atomic idempotence**

   The same initial route RED covered first execution, response-loss replay, mismatched replay evidence, cancellation, reassignment, wrong checkout run, wrong execution run, wrong JWT run/agent, missing execution lock, concurrent duplicate submissions, and a forced comment-insert failure. All were absent behind the initial `404`. GREEN proves a fixed `409` and no mutation for stale/mismatched requests, exactly one comment for concurrent same-run submissions, and rollback of `done` when receipt insertion fails.

   During self-review, a new focused regression enabled current-username redaction with a repository owner matching the host username. It went RED because the first receipt body was rewritten and the identical retry returned `409` instead of replay success. The narrow `redactCurrentUser: false` internal comment option made the exact-receipt/replay test GREEN without changing external comment defaults.

4. **Common synchronous terminal barrier**

   A focused run of the new failed/cancelled/timed-out conflicting-frame tests produced 4 failures in the terminal-race wave; each observed one forbidden disposition request while terminal logging was blocked. The shared synchronous latch made the focused race set GREEN (5 passed, 41 skipped), and the complete execute suite passed 46 tests.

5. **Deadline/cancellation barrier**

   The terminal-race RED also showed a completed frame arriving after local deadline cancellation could initiate disposition. GREEN rejects that frame with zero disposition requests. The complementary completion-first test establishes the policy: whichever callback synchronously claims the terminal latch first wins.

6. **Evidence grammar compatibility**

   The disposition/execute RED run reported 5 failures and 68 passes: it exposed the old generic PATCH/path/body, rejection of the valid `release/v1+meta` ref, and acceptance mismatch for unsafe configuration input. The shared validators and strict evidence schema made both files GREEN with 73 tests at that stage.

7. **Exact bounds and timer cleanup**

   New focused coverage pinned success at exactly 65,536 response bytes, rejection at 65,537 bytes, no abort at 9,999 ms, abort at 10,000 ms, and timer cleanup after both success and failure. Existing bounded-reader/timer behavior satisfied these tests; no production change beyond the dedicated endpoint request contract was needed for this finding.

8. **Deterministic log rejection test**

   The 100 ms wall-clock race was removed from the test. The replacement synchronizes on the completion-log attempt and awaits adapter settlement, leaving only the Vitest timeout as the outer bound. This was test-only hardening and passed in the final execute suite.

9. **Native-fetch and deadline hardening**

   Native local-server coverage proves redirects fail closed and a response whose headers arrive while the body stalls is aborted at the deadline. These cases passed with the existing bounded native-fetch implementation. The completion/deadline ordering test was RED before the shared synchronous terminal latch and is GREEN after it.

## GREEN verification

### Final focused feature suite

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/adapters/openhands-gateway/disposition.test.ts \
  server/src/adapters/openhands-gateway/execute.test.ts \
  server/src/__tests__/adapter-registry.test.ts \
  server/src/__tests__/heartbeat-runtime-skills.test.ts \
  server/src/__tests__/openhands-disposition-route.test.ts \
  server/src/services/recovery/successful-run-handoff.test.ts \
  --reporter=dot
```

Result: **6 files passed, 142 tests passed**.

### Recovery regressions

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/services/recovery/*.test.ts \
  server/src/__tests__/heartbeat-retry-scheduling.test.ts \
  --reporter=dot
```

Result: **7 files passed, 98 tests passed**.

### Isolated broad-lane OpenHands rerun

The broad general lane produced one failure in the existing special-permission-bits OpenHands test. Immediate isolation was GREEN:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/adapters/openhands-gateway/execute.test.ts \
  -t "rejects special permission bits"
```

Result: **1 test passed** (the remaining tests were filtered/skipped).

### Static and build verification

```bash
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server typecheck
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server build
git diff --check
```

Result: all commands exited **0**.

### Broad general lane

```bash
PATH=/opt/homebrew/bin:$PATH pnpm test:run:general
```

The command completed normally after 912.96 seconds with: **401 files total; 390 passed, 10 failed, 1 skipped; 4,742 tests total; 4,707 passed, 30 failed, 5 skipped**.

The remaining failures are outside this feature and cluster around environment-dependent existing tests: macOS `/tmp` versus `/private/tmp` canonicalization, automatically selected port values above 65,535, listener diagnostics, and workspace runtime cleanup/control/exposure. Broad-run child-process output also showed Node 22 in affected environment-dependent paths despite the Node 26 top-level runner. The only failure located in a modified OpenHands test was the special-permission-bits case; it passed in every focused feature run and in the immediate isolated rerun above. No broad-lane failure implicated the transactional endpoint, JWT boundary, persistence/replay behavior, recovery decision, or terminal barrier.

## Integration coverage

The route suite uses a real heartbeat-style local-agent JWT and real authentication middleware; it does not inject an actor directly. It crosses validation, routing, service transaction, database persistence, exact receipt replay, row-lock concurrency, rollback, and the successful-run recovery boundary. It proves:

- first execution persists a `done` issue and exactly one bounded, deterministic, agent/run-attributed comment;
- response-loss retry by the same run and exact evidence returns the existing receipt without a new comment;
- concurrent identical calls leave exactly one receipt;
- changed evidence or stale live state returns the same fixed rejection without mutation;
- a forced receipt insert failure rolls back the issue status change;
- a successfully persisted disposition suppresses missing-disposition corrective recovery wake creation.

The heartbeat integration test verifies the JWT claims for agent, company, adapter, and run through the actual registry boundary. It compares the captured token against serialized configuration/context, gateway dispatch, logs, and result evidence without printing the credential.

## Database migrations

None. The existing issue row lock serializes submissions, and an exact non-deleted comment keyed by company, issue, authenticated agent/run, deterministic body, and the dedicated authorization-reason metadata marker is sufficient as the atomic replay receipt. Status update and receipt insertion use existing primitives in the same transaction.

## Self-review

- **Token isolation:** the heartbeat token is supplied only in the local disposition request authorization header. It is absent from gateway dispatch/authorization, configuration, serialized context, logs, and result evidence. No test or report prints a token or raw environment.
- **Actor authority:** company, agent, and run values come exclusively from the verified `agent_jwt` actor. Board/API-key actors and JWTs without a run claim are rejected. Strict body validation rejects extra identity and free-form fields.
- **Atomicity and idempotence:** the issue row is locked before live-state and receipt checks. The update and comment use one transaction. Replay requires the exact receipt and does not insert another comment. The rollback trigger test proves no partial `done` state.
- **Stale requests:** cancellation, reassignment, wrong agent/run, missing locks, mismatched evidence, and other stale states share a fixed rejection and cause no mutation.
- **Evidence safety:** the server constructs the bounded comment from the strict tuple. Gateway summary/free-form text is never accepted or copied. Shared grammar accepts required Git-ref punctuation while rejecting controls, lone surrogates, normalization mismatches, unsafe repositories, and unsafe refs.
- **Terminal ordering:** one synchronous latch covers rejection, failed, cancelled, timed-out, indeterminate, completion, and local deadline cancellation. No awaited log opens a completion race.
- **Error leakage:** disposition failures remain fixed; response bodies, underlying errors, credentials, and sensitive URLs are not logged or returned as adapter evidence.
- **Scope:** the diff contains only the approved design/plan, focused server implementation, tests, and this report. No schema, migration, remote action, deployment, or unrelated cleanup was introduced.

## Remaining concern

The repository-wide general lane is not globally green because of the unrelated environment-dependent failures detailed above. The feature-focused suite, recovery suite, isolated OpenHands rerun, typecheck, build, and whitespace verification are green.
