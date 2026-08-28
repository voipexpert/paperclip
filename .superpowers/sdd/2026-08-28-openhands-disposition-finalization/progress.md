# SDD ledger — plan: docs/superpowers/plans/2026-08-28-openhands-disposition-finalization.md

Task 1: fix round 1/5 (4 addressed, 0 open — URL normalization bypass, identifier validation, timer cleanup, Node runtime evidence; commits f45673c..8eabcaa)
Task 1: complete (commits c35f408..8eabcaa, review clean)
Task 2: fix round 1/5 (4 addressed, 0 open — in-flight frame race, log rejection settlement, duplicate barrier, current retry suite; commits 7236e24..852259c)
Task 2: minor resolved/superseded: deterministic terminal settlement tests replaced the rejecting-onLog 100 ms wall-clock race (see final-fix-report.md)
Task 2: complete (commits 909d9c7..852259c, review clean)
Task 3: pending
Task 3: BLOCKED — final review conflicts with approved plan: generic PATCH /api/issues/{id} cannot condition on the live run/assignee or atomically/idempotently commit done status plus one evidence comment; reviewer recommends a dedicated transactional run-conditioned disposition operation
Task 3: block resolved by user approval — expand to a dedicated transactional, run-conditioned, idempotent disposition endpoint; one final-review fix wave authorized
Task 3: final fix wave (commits 4f9e54f..9f96351; all 9 original findings addressed)
Task 3: BLOCKED — mandatory scoped re-review found two new load-bearing regressions: non-completion terminal onLog rejection can leave execution unsettled after deadline clear; dedicated disposition route skips standard post-commit finalization hooks (routine/activity/lease cleanup/parent-dependent wake/watchdog)
Task 3: follow-up cycle approved by user — terminal settlement and idempotent shared lifecycle orchestration only
Task 3: follow-up fix round 1/5 (3 addressed, 0 open — sync/interaction proof, generic PATCH parity, deterministic replay drain; commit 3108e62)
Task 3: follow-up implementation complete (commits 9f96351..3108e62, review clean)
Task 4: pending
