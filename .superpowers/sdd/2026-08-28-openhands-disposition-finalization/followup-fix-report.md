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
