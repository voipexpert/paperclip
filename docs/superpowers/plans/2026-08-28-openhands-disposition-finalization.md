# OpenHands Disposition Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a validated OpenHands gateway completion atomically useful to Paperclip by recording the assigned issue's done disposition before adapter success.

**Architecture:** Add a focused server-side disposition client and call it once from the OpenHands adapter's validated-completion path. The client uses only the per-run Paperclip auth token and server-owned API URL, performs a bounded authenticated PATCH, and returns success only after Paperclip confirms the same issue is done.

**Tech Stack:** TypeScript, Node 24 native `fetch`/Web Streams/`AbortSignal`, Vitest, pnpm.

## Global constraints

- Keep Paperclip credentials inside the Paperclip server. Never send them to OpenHands, Canvas, the coding VM, GitHub, logs, comments, or result evidence.
- Use only the existing per-run `context.authToken` and server-owned `PAPERCLIP_API_URL`.
- Mutate Paperclip only after correlated OpenHands evidence has passed all existing completion validation.
- Do not mutate issue state for failure, cancellation, timeout, malformed evidence, or any other non-completion outcome.
- The Paperclip comment must be deterministic and built only from validated repository, base-ref, commit, and change/no-change state. Never copy the worker's free-form summary.
- Reject redirects. Bound the request to 10 seconds and the response to 65,536 bytes. Decode UTF-8 fatally and validate the response issue ID and `done` status.
- Convert every disposition failure to the fixed adapter error `OPENHANDS_DISPOSITION`; do not leak response bodies, URLs containing credentials, tokens, or underlying error details.
- Preserve all existing gateway protocol, replay, recovery, timeout, pause, and ledger semantics.
- Keep the coding VM unchanged. Only the final explicitly approved read-only snapshot may touch it.
- Implement with tests first, small commits, independent review, and fresh verification before merge or deployment.

## Task 1: Build the bounded Paperclip disposition client

**Files:**

- Create: `server/src/adapters/openhands-gateway/disposition.ts`
- Create: `server/src/adapters/openhands-gateway/disposition.test.ts`

- [ ] Write a failing happy-path test that injects a request function, captures exactly one `PATCH` to `http://127.0.0.1:3100/api/issues/task-1`, and verifies `Authorization: Bearer run-token`, JSON content type, `status: "done"`, and this deterministic no-change comment:

  ```text
  OpenHands completed with validated no-change evidence for voipexpert/openhands-worker-acceptance at main commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.
  ```

- [ ] Add a changed-evidence case using the fixed phrase `validated change evidence`, and prove an arbitrary evidence `summary` string is never copied into the request.

- [ ] Add failing validation tests for missing/blank auth token; missing or malformed API URL; non-HTTP(S) schemes; URL credentials, query, or fragment; and a base path other than empty, `/`, or one ending in `/api`.

- [ ] Add failing response tests for redirects, non-2xx responses, an incrementally streamed body over 65,536 bytes, invalid UTF-8, malformed JSON, mismatched issue ID, and any returned status other than `done`.

- [ ] Add a timeout/abort test and a case proving a matching issue already in `done` is accepted.

- [ ] Run the focused test and confirm the new suite fails because the module is absent:

  ```bash
  pnpm exec vitest run server/src/adapters/openhands-gateway/disposition.test.ts
  ```

- [ ] Implement this public surface:

  ```ts
  export class OpenHandsDispositionError extends Error {}

  export async function finalizeOpenHandsDisposition(
    input: {
      issueId: string;
      evidence: Record<string, unknown>;
      authToken: string | undefined;
      apiUrl: string | undefined;
    },
    request: typeof fetch = globalThis.fetch,
  ): Promise<void>;
  ```

- [ ] Define `RESPONSE_LIMIT = 65_536` and `REQUEST_TIMEOUT_MS = 10_000`. Normalize an allowed API base to a single `/api/issues/{encodedIssueId}` target, set `redirect: "error"`, and use an abort signal.

- [ ] Read the response body incrementally, cancel once it exceeds the limit, decode it with fatal UTF-8 handling, parse JSON, and require the returned object to identify the same issue with status `done`.

- [ ] Ensure every rejection is a fresh fixed `OpenHandsDispositionError` without a `cause` or sensitive detail.

- [ ] Run focused tests and server type checking:

  ```bash
  pnpm exec vitest run server/src/adapters/openhands-gateway/disposition.test.ts
  pnpm --filter @paperclip/server typecheck
  git diff --check
  ```

- [ ] Commit the isolated client and tests:

  ```bash
  git add server/src/adapters/openhands-gateway/disposition.ts server/src/adapters/openhands-gateway/disposition.test.ts
  git commit -m "feat(openhands): add bounded issue disposition client"
  ```

## Task 2: Gate adapter success on issue disposition

**Files:**

- Modify: `server/src/adapters/openhands-gateway/execute.ts`
- Modify: `server/src/adapters/openhands-gateway/execute.test.ts`

- [ ] Extend the adapter test context with a per-run auth token and save/restore `PAPERCLIP_API_URL` around every test.

- [ ] Add a local HTTP-server test that defers its response. Assert the adapter promise remains pending and no completion log is emitted until Paperclip confirms the issue is done.

- [ ] Add a duplicate-completed-frame test and assert exactly one disposition PATCH.

- [ ] Add failure tests for missing auth, missing API URL, and any disposition-client rejection. Each must return the fixed `OPENHANDS_DISPOSITION` error after validated completion and must not leak details.

- [ ] Add a parameterized test proving every non-completion outcome performs zero disposition requests.

- [ ] Run the focused adapter test and confirm the new assertions fail before production code changes:

  ```bash
  pnpm exec vitest run server/src/adapters/openhands-gateway/execute.test.ts
  ```

- [ ] Import `finalizeOpenHandsDisposition`, define the fixed disposition error result, and add a per-execution `completionStarted` guard.

- [ ] In the existing validated `completed` branch only: return immediately for a duplicate frame; set the guard; clear the deadline timer; await disposition using `issue.id`, the validated result evidence, `context.authToken`, and `process.env.PAPERCLIP_API_URL`; map failure to `OPENHANDS_DISPOSITION`; then emit the existing completion log and finish successfully.

- [ ] Leave all correlation, evidence validation, ledger, replay, failure, cancellation, recovery, and timeout branches unchanged.

- [ ] Run focused and regression tests plus type checking:

  ```bash
  pnpm exec vitest run server/src/adapters/openhands-gateway/disposition.test.ts server/src/adapters/openhands-gateway/execute.test.ts
  pnpm exec vitest run server/src/adapters/openhands-gateway/recovery.test.ts server/src/services/agent-runtime-service.pause.test.ts server/src/services/heartbeat-retry.test.ts
  pnpm --filter @paperclip/server typecheck
  git diff --check
  ```

- [ ] Commit the adapter integration:

  ```bash
  git add server/src/adapters/openhands-gateway/execute.ts server/src/adapters/openhands-gateway/execute.test.ts
  git commit -m "feat(openhands): finalize issue before adapter success"
  ```

## Task 3: Review, merge, and deploy Paperclip immutably

- [ ] Run the complete pre-review verification from a clean branch:

  ```bash
  pnpm exec vitest run server/src/adapters/openhands-gateway/disposition.test.ts server/src/adapters/openhands-gateway/execute.test.ts
  pnpm exec vitest run server/src/adapters/openhands-gateway/recovery.test.ts server/src/services/agent-runtime-service.pause.test.ts server/src/services/heartbeat-retry.test.ts
  pnpm --filter @paperclip/server typecheck
  pnpm --filter @paperclip/server build
  git diff --check origin/master...HEAD
  git status --short
  ```

- [ ] Dispatch two independent read-only reviews: one for correctness/security against the approved design, and one for test quality/regression risk. Address findings with test-first follow-up commits and repeat verification.

- [ ] Push the feature branch, open a PR with the design and verification evidence, wait for required checks, and merge only after both independent reviews pass.

- [ ] Record the exact merged commit and create an immutable source archive from that commit. Verify its checksum before deployment; do not deploy a mutable checkout or run `git pull` on the host.

- [ ] Confirm the OpenHands worker is paused and the sanitized gateway ledger has zero active attempts.

- [ ] On `plane` only, build a versioned Paperclip image/release from the verified archive, record the image ID and release metadata, deploy only Paperclip, and verify its health/version. Preserve the prior image/release for rollback.

- [ ] Confirm Canvas automations remain disabled with zero runs, OpenHands remains paused, and the coding VM was not contacted.

## Task 4: Run production acceptance and close out safely

- [ ] Preserve and validate the VTH-20 evidence, then cancel/unassign the issue if still needed. Validate the exact known VTH-20 workspaces before removing only those two paths:

  ```text
  pc-37cbae83d121efe8ae82
  pc-b8b935ea8656f1ba1588
  ```

- [ ] Create one fresh acceptance canary against `voipexpert/openhands-worker-acceptance` at baseline `50593c91e35ae333e8ba5010d2ac16403cab94d9`, assign only the OpenHands worker, resume it for the canary, and enforce a 660-second bound.

- [ ] Require all of the following before acceptance: exactly one new completed gateway-ledger row; zero active rows; one new workspace and one conversation; valid correlated no-change evidence for repository `voipexpert/openhands-worker-acceptance`, base ref `main`, and the baseline commit; a successful Paperclip run; issue status `done`; and no corrective retry or missing-disposition activity.

- [ ] Replay the exact same signed envelope and verify idempotence: no new ledger row, workspace, conversation, GitHub mutation, or issue transition.

- [ ] Compare GitHub with the recorded baseline: 8 branches, 5 open PRs, 2 open non-PR issues, and unchanged acceptance-repository commit. Confirm Canvas automations are still disabled with zero runs.

- [ ] Run final health and security attestations for Paperclip, OpenHands, CLIProxyAPI integration, the sanitized gateway ledger, service identities, release/image IDs, firewall/reachability, and exact disposable-workspace ownership/modes. Do not print secrets, raw environments, raw logs, or free-form worker prompts/summaries.

- [ ] Take the single approved final read-only coding-VM snapshot and confirm no changes were made there.

- [ ] Leave the worker active only if it is idle and has no actionable assigned issues; otherwise leave it paused and report the reason.

- [ ] Revoke the temporary Paperclip CLI authentication with `/api/cli-auth/revoke-current`, delete only the exact temporary auth file, and verify it no longer exists. Never print its token.

- [ ] Deliver the merged commit, deployed release/image identifiers, sanitized acceptance counts, rollback reference, final worker state, and any remaining operational caveat.

## Plan acceptance checklist

- [ ] Confirm every approved design requirement maps to a test or production acceptance assertion above.
- [ ] Confirm no placeholder language remains:

  ```bash
  rg -n 'T[B]D|T[O]DO|i[m]plement later|f[i]ll in details|S[i]milar to Task' docs/superpowers/plans/2026-08-28-openhands-disposition-finalization.md
  ```

- [ ] Confirm formatting and repository state:

  ```bash
  git diff --check
  git status --short
  ```
