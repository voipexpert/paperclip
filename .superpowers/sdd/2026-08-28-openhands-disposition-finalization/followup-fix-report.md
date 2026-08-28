# OpenHands follow-up fix report

Date: 2026-08-28

Scope: the two findings authorized in `followup-fix-brief.md`: terminal logging settlement and post-commit issue-finalization lifecycle parity. All work stayed in the assigned local worktree under Node `v26.4.0`. No remote, VM, production Paperclip, GitHub, Canvas, OpenHands, or coding-VM action was performed.

## Outcome

- Every correlated terminal outcome now selects its result before best-effort logging, and a rejected terminal log cannot prevent settlement or alter the fixed result.
- The dedicated disposition route still commits `done` plus its exact receipt atomically. On the first commit only, it invokes a shared post-commit completion orchestrator also used by the exact applicable generic PATCH transition.
- An exact receipt replay returns the existing receipt and invokes zero additional lifecycle effects.
- Post-commit hook failures are isolated and do not roll back the receipt, change the successful response, leak details, or cause a replay to repeat mutation.
- No migration was required.

## Hook mapping

The generic `PATCH /api/issues/{issueId}` path was traced for an agent-run `in_progress` to `done` transition with a completion comment. The shared orchestrator owns these applicable effects:

| Effect | Ordering/isolation | Replay and idempotency policy |
| --- | --- | --- |
| routine-run status synchronization | awaited after commit, isolated | first disposition only |
| heartbeat run-activity touch | awaited after commit, isolated | first disposition only |
| comment reference and external-object synchronization | awaited and isolated when the caller has not already synchronized | first disposition only |
| request-confirmation expiry for the evidence comment | awaited and isolated when the caller has not already expired it | first disposition only |
| `issue.updated` and `issue.comment_added` activity | awaited individually and isolated | first disposition only; exactly two rows in the production-shaped test |
| dependent readiness wakes | detached post-commit, each step isolated | existing ready-state lookup plus `issue_blockers_resolved:state:*` key |
| terminal interaction expiry | detached post-commit and isolated | first disposition only |
| reusable sandbox-lease cleanup | detached post-commit and isolated | first disposition only |
| parent completion wake | detached post-commit and isolated | stable `issue_children_completed:<parent>:<child>` key |
| task-watchdog reconciliation | awaited after commit and isolated | first disposition only |

The generic PATCH path delegates only the exact `in_progress` to `done` plus comment case and gates its former duplicate routine/activity/wake/cleanup/watchdog branches. It continues to own unrelated branches. Assignee-comment wakes, mentions, blocked/restoration wakes, and stop relays are not applicable to the dedicated server-constructed completion evidence and were not added.

The dedicated route calls the orchestrator only when the transactional service returns `replayed: false`. The receipt row lock serializes response-loss/concurrent retries, and replay skips synchronization, activity, cleanup, wake, and watchdog mutation. This keeps the atomic receipt as the source of truth and avoids unsafe hook retries after an isolated post-commit failure.

## Strict TDD evidence

### Finding 1 RED

Command:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/adapters/openhands-gateway/execute.test.ts \
  -t "settles .* when terminal logging rejects" \
  --reporter=verbose
```

Observed before the production edit: **1 file failed; 4 tests failed, 46 skipped; 4 expected unhandled log rejections**. Each rejected-acknowledgement, failed, cancelled, and timed-out case reached its synchronized terminal log attempt but the adapter promise never settled, so the outer 15,000 ms Vitest timeout fired. Total duration was 60.30 s.

Minimal GREEN: add one local best-effort terminal-log boundary and use it for rejected acknowledgement, completion, failure, cancellation, and timeout after the existing common terminal latch/deadline clear. The latch, disposition ordering, fixed result objects, and zero-disposition rules were unchanged.

Targeted GREEN for the same command: **1 file passed; 4 tests passed, 46 skipped** in 264 ms on the final rerun. Tests synchronize on the terminal log attempt and use no inner wall-clock race. They also assert the injected private log failure detail is absent from the adapter result.

### Finding 2 RED

Command:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/__tests__/openhands-disposition-route.test.ts \
  -t "normal completion lifecycle|post-commit hook failure" \
  --reporter=verbose
```

Observed before the production edit: **1 file failed; 2 tests failed, 13 skipped**. Both requests crossed real local-agent JWT middleware and committed the real embedded-Postgres issue/receipt transaction, but every injected lifecycle hook had zero calls. Duration was 6.51 s.

Minimal GREEN: add the route-local shared orchestrator, call it after a first dedicated commit, and delegate the exact generic PATCH completion case to it while suppressing legacy duplicates. The first production run showed the failure-isolation test GREEN and only one normal-lifecycle assertion racing an intentionally detached cleanup effect; the test was made deterministic with `vi.waitFor` around detached cleanup/wakes without changing production behavior.

Final targeted GREEN: **1 file passed; 2 tests passed, 13 skipped**. The production-shaped lifecycle fixture proves routine completion, one run-activity touch, two activity rows, cleanup, dependent wake, parent wake, and watchdog reconciliation. It then sends an exact receipt replay and proves every hook/activity count remains unchanged. The injected-failure case proves a throwing routine hook cannot change either successful response, expose the failure detail, prevent later independent hooks, or create a second receipt comment.

## Final verification

### Focused OpenHands feature lane

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

Result: **6 files passed, 148 tests passed**.

### Shared generic lifecycle routes

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/__tests__/issue-dependency-wakeups-routes.test.ts \
  server/src/__tests__/issue-activity-events-routes.test.ts \
  server/src/__tests__/issue-thread-interaction-routes.test.ts \
  server/src/__tests__/issue-watchdogs-routes.test.ts \
  --reporter=dot
```

Result: **4 files passed, 94 tests passed**.

### Recovery lane

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/services/recovery/*.test.ts \
  server/src/__tests__/heartbeat-retry-scheduling.test.ts \
  --reporter=dot
```

Result: **7 files passed, 98 tests passed**.

### Static, build, and diff checks

```bash
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server typecheck
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server build
git diff --check
```

Result: all commands exited 0. Typecheck was rerun after the final type-only refactor. The build completed and wrote the existing local build stamp. A focused diff scan found no bearer value or JWT-secret assignment.

## Files and commits

Modified implementation/tests/docs:

- `server/src/adapters/openhands-gateway/execute.ts`
- `server/src/adapters/openhands-gateway/execute.test.ts`
- `server/src/routes/issues.ts`
- `server/src/__tests__/openhands-disposition-route.test.ts`
- `docs/superpowers/specs/2026-08-28-openhands-disposition-finalization-design.md`
- `docs/superpowers/plans/2026-08-28-openhands-disposition-finalization.md`

Implementation and design commit:

- `001dbcad65de577fec319c331e3aac268563df95` — `fix(openhands): preserve terminal completion lifecycle`

This report is committed separately so it can record the implementation commit exactly; its own report-only commit is recorded in the final handoff.

## Self-review

- Confirmed terminal branches retain the shared synchronous first-terminal latch and deadline clear before logging; only the logging await gained a catch boundary.
- Confirmed no terminal log rejection detail enters fixed adapter results.
- Confirmed the dedicated route still derives company/agent/run only from the verified `agent_jwt` actor and accepts no new identity input.
- Confirmed the issue service transaction and replay predicate were not changed: live issue/agent/run locks, one exact marked receipt, rollback, stale-state rejection, and recovery suppression remain intact.
- Confirmed lifecycle work begins only after transaction success, uses independent failure boundaries, and never changes the already selected response.
- Confirmed receipt replay calls no lifecycle hook and writes no duplicate activity/comment.
- Confirmed dependency and parent wakes have deterministic idempotency keys and the generic PATCH branch cannot invoke both the orchestrator and its legacy duplicate effects.
- Confirmed no response body, credential, raw environment, worker summary, token, or private injected error detail was added to logs, results, evidence, documentation, or the diff.
- Confirmed the diff is limited to the two authorized findings, their tests, and required design/plan/report documentation.

Concerns: none within the approved scope. As designed, an isolated lifecycle hook failure is logged and is not retried by exact receipt replay; this deliberately prioritizes no unsafe repeated mutation after the atomic receipt is committed.

## Review follow-up round 1/5

Review requested three additional proofs: observable comment-reference/external-object and interaction-expiry phases, a real generic PATCH parity regression, and a deterministic drain for detached completion work.

### Additional root-cause mapping

- The original production code performed comment reference/external-object synchronization and both route-level interaction-expiry calls, but the production-shaped disposition test could not observe them.
- The prior test waited only until first-request cleanup/wakes happened. Because receipt replay schedules no shared lifecycle work, that wait did not create a deterministic post-replay background opportunity.
- The generic PATCH branch called the shared orchestrator, but no real authenticated PATCH test proved exact-once behavior or that removing a legacy gate would duplicate routine/activity/interaction/cleanup/wake/watchdog effects.
- The issue service itself expires all pending interactions inside the atomic terminal status update, before the agent/run-attributed receipt is inserted. Separately, `expireRequestConfirmationsSupersededByComment` intentionally accepts only a genuine human comment: an agent receipt has `createdByRunId` and cannot be treated as human supersession. The follow-up preserves both security/transaction semantics. The fixture therefore seeds one supersedable confirmation plus one non-supersedable remaining interaction, proves both real route-level expiry phases are invoked once, and verifies both rows end `expired` with `issue_closed`. It does not falsify the attribution model by forcing the agent receipt to produce `superseded_by_comment`.

### RED

Tests were changed before the production seam. Command:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/__tests__/openhands-disposition-route.test.ts \
  -t "normal completion lifecycle|shared lifecycle exactly once|post-commit hook failure" \
  --reporter=verbose
```

Observed result: **1 file failed; 2 tests failed, 1 passed, 13 skipped**. The enhanced real-JWT disposition test and the new real-JWT generic PATCH test each failed at the first independently observable missing behavior: expected one comment-reference synchronization call, received zero. This proved the existing test seam could not cover the required behavior. The hook-failure regression remained GREEN.

### Minimal implementation

- Added call-through lifecycle operations for comment reference sync, external-object sync, comment-confirmation expiry, and terminal interaction expiry. Production defaults remain the existing real services.
- Routed the applicable generic PATCH operations and legacy branches through the same operations. Consequently, the real generic parity test's exact-once counts fail if any delegation gate is removed.
- Added one production-safe detached scheduler seam. Production immediately starts an effect and catches/logs a rejection; tests capture every scheduled promise and drain the queue to completion.
- The disposition test drains the first completion, sends exact receipt replay, drains again, and then asserts every operation/scheduler/activity count is unchanged. The generic PATCH test drains both shared and supplemental generic background tasks before asserting exact-once mutation.
- Seeded real embedded-Postgres routine, parent/dependent relation, supersedable confirmation, and remaining terminal interaction state. Synchronization and interaction probes call through to the real services; only remote/runtime cleanup, heartbeat wake, and watchdog boundaries remain controlled doubles.

### GREEN and regression evidence

Targeted lifecycle command after implementation: **1 file passed; 3 tests passed, 13 skipped**.

Full disposition route:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run \
  server/src/__tests__/openhands-disposition-route.test.ts \
  --reporter=dot
```

Result: **1 file passed, 16 tests passed**.

Final focused OpenHands lane (same six-file command recorded above): **6 files passed, 149 tests passed**.

Shared generic lifecycle routes (same four-file command recorded above): **4 files passed, 94 tests passed**.

Recovery lane (same seven-file command recorded above): **7 files passed, 98 tests passed**.

Static/build/diff commands:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server typecheck
PATH=/opt/homebrew/bin:$PATH pnpm --filter @paperclipai/server build
git diff --check
```

Result: all exited 0 under Node 26. The final feature run was repeated after removing an invalid assertion about which layer returned the expired rows; persisted real interaction state and exact route-level call counts remain asserted.

### Round 1 self-review

- The seam defaults are the previous real production operations; only tests inject call-through probes and a promise collector.
- Generic non-delegated paths still receive the same routine, run-activity, sync, interaction, cleanup, wake, and watchdog behavior through the shared dependency object.
- The generic delegated completion test observes exactly one routine sync, run touch, comment reference sync, external sync, each route-level interaction phase, cleanup, watchdog reconciliation, two intended wakes, two activity rows, and one comment after draining all scheduled work.
- Receipt replay produces no second scheduled shared lifecycle task and no effect/activity count change after the deterministic second drain.
- No JWT, raw environment, response body, token, or private hook failure was logged or added to evidence.

Updated concern: the review phrase "superseded request confirmation" cannot literally apply to the OpenHands receipt without weakening an intentional invariant. The receipt is agent/run-attributed, and the service only lets genuine human comments supersede confirmations; additionally, the atomic terminal update expires pending interactions before receipt insertion. This round tests the real behavior rather than changing those established semantics.
