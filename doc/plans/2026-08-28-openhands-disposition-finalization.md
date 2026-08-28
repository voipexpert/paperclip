# OpenHands Disposition Finalization Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans`, strict test-driven development, and Node 26 (`PATH=/opt/homebrew/bin:$PATH`).

**Goal:** Record a validated OpenHands completion as one authenticated, run-conditioned, atomic and idempotent Paperclip disposition before adapter success.

**Architecture:** The adapter calls `POST /api/issues/{issueId}/openhands-disposition` with a strict bounded evidence tuple. Real local-JWT middleware supplies the actor. The issue service locks the issue row, validates live ownership/execution locks, and commits `done` plus one exact run-attributed receipt comment in a single transaction. The client confirms the matching issue/status under existing redirect, deadline, body-size, UTF-8, fixed-error, and HTTPS-or-loopback transport protections.

**Tech Stack:** TypeScript, Express, Drizzle/PostgreSQL, Node 26 native fetch/Web Streams, Vitest, pnpm.

## Global constraints

- Keep all work local to the assigned worktree. Do not contact or mutate any remote, production service, VM, GitHub, Paperclip deployment, Canvas, OpenHands deployment, or coding VM.
- Keep the heartbeat JWT server-only. Never send it to the gateway/WebSocket, adapter config/context serialization, logs, result JSON/evidence, or worker.
- Derive company, agent, and run identity only from a verified local-agent JWT actor. Reject board actors, API-key actors, missing run claims, and request identity fields.
- Accept only strict bounded evidence fields and construct the deterministic comment server-side. Never accept or copy free-form summary/comment text.
- First execution requires live `in_progress` status, actor assignment, actor `checkoutRunId`, actor `executionRunId`, and a present execution lock.
- Commit `done` and one receipt comment atomically. A same-run exact-evidence replay may return the existing receipt without a new comment; all stale or mismatched requests fail with a fixed response and no mutation.
- Preserve redirect rejection, 10,000 ms deadline, 65,536-byte response limit, fatal UTF-8, response identity/status confirmation, fixed errors, and timer cleanup.
- Follow RED → minimal GREEN → refactor for every production behavior.

## Task 1: Amend and pin the architecture

**Files:**

- Modify `docs/superpowers/specs/2026-08-28-openhands-disposition-finalization-design.md`
- Modify `doc/plans/2026-08-28-openhands-disposition-finalization.md`

- [ ] Replace the generic PATCH design with the approved dedicated endpoint and transaction invariants.
- [ ] Document the exact receipt, replay, stale-state, terminal-race, evidence, and token-isolation rules.
- [ ] State explicitly that this fix wave performs no remote or production action.

## Task 2: Enable and prove server-only run JWT delivery

**Files:**

- Modify `server/src/__tests__/adapter-registry.test.ts`
- Modify `server/src/__tests__/heartbeat-runtime-skills.test.ts`
- Modify `server/src/adapters/registry.ts`
- Modify `server/src/adapters/openhands-gateway/execute.test.ts`

- [ ] RED: require the built-in OpenHands adapter to declare local-agent JWT support.
- [ ] RED: run a real embedded-database heartbeat through the registry boundary, verify the captured token claims match agent/company/run/adapter, and prove serialized adapter inputs/log/result evidence exclude it.
- [ ] GREEN: set only the built-in capability needed for heartbeat minting.
- [ ] Verify gateway dispatch and gateway authorization still contain only the gateway credential and bounded dispatch fields.

## Task 3: Add the transactional disposition operation

**Files:**

- Create `server/src/adapters/openhands-gateway/disposition-contract.ts`
- Modify `server/src/services/issues.ts`
- Modify `server/src/routes/issues.ts`
- Create `server/src/__tests__/openhands-disposition-route.test.ts`

- [ ] RED: exercise real local-JWT authentication and require the dedicated route to atomically persist `done` plus one exact agent/run-attributed bounded comment.
- [ ] RED: prove response-loss replay returns success with one comment and mismatched replay evidence fails without mutation.
- [ ] RED: cover cancelled, reassigned, wrong-run, wrong-agent, missing checkout/execution lock, and no-lock states with one fixed rejection.
- [ ] RED: prove a forced comment-insert failure rolls back the status transition.
- [ ] GREEN: add a strict bounded evidence schema and server-side deterministic comment builder.
- [ ] GREEN: lock the issue row, use the existing issue update/comment attribution primitives in one transaction, and use the exact marked comment as the receipt.
- [ ] GREEN: accept only `agent_jwt` actors and pass only actor-derived identity into the service.
- [ ] Verify the persisted `done` issue makes successful-run handoff recovery skip corrective wake creation.
- [ ] Confirm no migration is needed; if the receipt cannot satisfy atomic idempotence, stop and add only the smallest schema/index change through the normal migration workflow.

## Task 4: Switch the bounded client to the dedicated contract

**Files:**

- Modify `server/src/adapters/openhands-gateway/disposition.test.ts`
- Modify `server/src/adapters/openhands-gateway/disposition.ts`
- Modify `server/src/adapters/openhands-gateway/contract.ts`

- [ ] RED: require one `POST` to the dedicated endpoint with only `outcome`, `repository`, `baseRef`, and `commit`; prove gateway summary is absent.
- [ ] RED: require Git-ref punctuation such as `release/v1+meta` to pass and unsafe/control input to fail before a request.
- [ ] GREEN: reuse the shared disposition contract in config validation, completion validation, client request construction, and route validation.
- [ ] Preserve percent-encoded issue paths, bearer authorization, JSON content type, redirect rejection, and fixed errors.

## Task 5: Close terminal and cancellation races

**Files:**

- Modify `server/src/adapters/openhands-gateway/execute.test.ts`
- Modify `server/src/adapters/openhands-gateway/execute.ts`

- [ ] RED: block a failure/cancel/timeout log, send a conflicting completion, synchronize on the log attempt, and require zero disposition requests.
- [ ] RED: with fake timers, start local cancellation and then deliver completed evidence; require zero disposition requests.
- [ ] RED: define the completion/deadline race policy: the callback that synchronously latches first wins.
- [ ] GREEN: set one common terminal guard synchronously before every await and reject messages after local cancellation begins.
- [ ] Remove the 100 ms rejecting-log race by synchronizing on the completion-log attempt and awaiting normal promise settlement, using only the test runner timeout as an outer bound.

## Task 6: Pin exact client bounds and native-fetch behavior

**Files:**

- Modify `server/src/adapters/openhands-gateway/disposition.test.ts`
- Modify `server/src/adapters/openhands-gateway/disposition.ts` only if a new focused test is RED.

- [ ] Test a valid success body of exactly 65,536 bytes and rejection at 65,537 bytes.
- [ ] With fake timers, prove no abort at 9,999 ms and abort at 10,000 ms.
- [ ] Prove the deadline timer is cleared after success and failure.
- [ ] Add native-fetch local-server coverage for redirects and headers-arrive/body-stalls timeout behavior.
- [ ] Make only the minimal production adjustment required by an observed RED.

## Task 7: Verification, report, and commit

- [ ] Run focused disposition/execute/registry/heartbeat/route/recovery suites under Node 26.
- [ ] Run the current recovery regression suites named by the prior verified reports.
- [ ] Run server typecheck, server build, `git diff --check`, and the broad Vitest command appropriate to the final diff.
- [ ] Review the complete diff for token leakage, response/body leakage, stale-state mutation, duplicate receipts, identity fields, unintended route authorization, and unrelated changes.
- [ ] Write `.superpowers/sdd/2026-08-28-openhands-disposition-finalization/final-fix-report.md` with files/architecture, RED evidence per finding, GREEN commands/counts, integration coverage, migrations, commits, and self-review.
- [ ] Commit the complete fix wave locally. Do not push or open a PR.

## Task 8: Follow-up terminal settlement and completion lifecycle

**Files:**

- Modify `server/src/adapters/openhands-gateway/execute.test.ts`
- Modify `server/src/adapters/openhands-gateway/execute.ts`
- Modify `server/src/__tests__/openhands-disposition-route.test.ts`
- Modify `server/src/routes/issues.ts`
- Modify this plan and the design document

- [x] RED: make terminal `onLog` reject for rejected acknowledgement, failure, cancellation, and timeout; observe all four adapter promises remain unsettled until the outer deterministic test timeout.
- [x] GREEN: route every terminal log through a best-effort boundary after the common terminal latch, preserving the fixed selected result and zero-disposition rule.
- [x] Map the applicable generic PATCH completion hooks and exclude assignee-comment wakes, mentions, blocked/restoration wakes, and stop relays from dedicated server-constructed evidence.
- [x] RED: prove the dedicated route commits successfully but runs none of the mapped lifecycle hooks, and prove a throwing post-commit hook has no isolation contract.
- [x] GREEN: extract the smallest shared post-commit orchestrator, invoke it after first disposition commit, and reuse it for the exact generic PATCH `in_progress` to `done` transition with a comment.
- [x] Make hook failures independent and non-transactional; use stable dependency-ready-state and parent-completion wake keys.
- [x] On exact receipt replay, return the existing receipt and skip all lifecycle effects so response-loss retries cannot duplicate mutation.
- [x] Run the focused adapter, route, lifecycle, recovery, server typecheck/build, and diff checks; record all evidence in `followup-fix-report.md`.

## Acceptance checklist

- [ ] Every final-review finding maps to a focused test or an explicitly documented no-production-change coverage addition.
- [ ] No placeholders remain in this plan or design.
- [ ] No secret, raw environment, raw remote response, worker summary, or token appears in logs, dispatch, evidence, report, or git diff.
- [ ] `git diff --check` and `git status --short` show only the intended local fix wave before commit.
