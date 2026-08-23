# Fork-Internal FirstMate Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FirstMate gateway a server-internal adapter so the `voipexpert/paperclip` fork builds and releases without publishing `@paperclipai/adapter-firstmate-gateway` to npm.

**Architecture:** Preserve the existing FirstMate implementation and public Paperclip adapter identifier while relocating its TypeScript module into `server/src/adapters/firstmate-gateway`. The server registry will use local imports, and the obsolete workspace-package, Docker dependency-stage, lockfile, and release-manifest enrollment will be removed.

**Tech Stack:** TypeScript, Node.js test runner, pnpm workspaces, Paperclip release-manifest tooling, Docker multi-stage builds.

## Global Constraints

- Preserve adapter type `firstmate_gateway`, configuration schema, gateway protocol, heartbeat behavior, lifecycle handling, and UI behavior.
- Do not publish a replacement npm package.
- Do not deploy, restart, or rebuild the running production container.
- Do not refactor unrelated adapters or release tooling.
- Work only in `/opt/paperclip/source/.worktrees/firstmate-paperclip-worker`.

---

### Task 1: Add a release-topology regression test and internalize the adapter

**Files:**
- Create: `scripts/firstmate-internal-adapter.test.mjs`
- Create by moving: `server/src/adapters/firstmate-gateway/index.ts`
- Create by moving: `server/src/adapters/firstmate-gateway/execute.ts`
- Create by moving: `server/src/adapters/firstmate-gateway/execute.test.ts`
- Create by moving: `server/src/adapters/firstmate-gateway/test.ts`
- Modify: `server/src/adapters/registry.ts`
- Modify: `server/package.json`
- Modify: `scripts/release-package-manifest.json`
- Modify: `Dockerfile`
- Modify: `pnpm-lock.yaml`
- Remove: `packages/adapters/firstmate-gateway/package.json`
- Remove: `packages/adapters/firstmate-gateway/tsconfig.json`
- Remove: `packages/adapters/firstmate-gateway/src/index.ts`
- Remove: `packages/adapters/firstmate-gateway/src/server/index.ts`
- Remove: `packages/adapters/firstmate-gateway/src/server/execute.ts`
- Remove: `packages/adapters/firstmate-gateway/src/server/execute.test.ts`
- Remove: `packages/adapters/firstmate-gateway/src/server/test.ts`

**Interfaces:**
- Consumes: `AdapterExecutionContext`, `AdapterExecutionResult`, `AdapterEnvironmentTestContext`, and `AdapterEnvironmentTestResult` from `@paperclipai/adapter-utils`; `WebSocket` from `ws`.
- Produces: local exports `type`, `label`, `models`, `agentConfigurationDoc`, `execute(context)`, and `testEnvironment(context)` consumed by `server/src/adapters/registry.ts`.

- [ ] **Step 1: Write the failing topology test**

Create `scripts/firstmate-internal-adapter.test.mjs` with assertions over real repository files:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");

test("FirstMate is server-internal and excluded from npm release topology", () => {
  const packageName = "@paperclipai/adapter-firstmate-gateway";
  const serverPackage = JSON.parse(read("server/package.json"));
  const releaseManifest = JSON.parse(read("scripts/release-package-manifest.json"));

  assert.equal(serverPackage.dependencies?.[packageName], undefined);
  assert.equal(releaseManifest.some((entry) => entry.name === packageName), false);
  assert.equal(read("Dockerfile").includes("packages/adapters/firstmate-gateway"), false);
  assert.equal(read("server/src/adapters/registry.ts").includes(packageName), false);
  assert.equal(existsSync(`${root}/packages/adapters/firstmate-gateway/package.json`), false);
  assert.equal(existsSync(`${root}/server/src/adapters/firstmate-gateway/execute.ts`), true);
});
```

- [ ] **Step 2: Run the topology test and verify RED**

Run:

```bash
node --test scripts/firstmate-internal-adapter.test.mjs
```

Expected: FAIL because the server dependency, release-manifest entry, Docker copy, package directory, and external registry import still exist.

- [ ] **Step 3: Move the implementation without changing behavior**

Use `git mv` for `index.ts`, `execute.ts`, `execute.test.ts`, and `test.ts`. Remove the obsolete package `src/server/index.ts`, `package.json`, `tsconfig.json`, generated `dist`, and now-empty directories. Preserve the source bytes of the four moved TypeScript files.

- [ ] **Step 4: Switch the registry to local imports**

Replace the two package imports with:

```ts
import {
  execute as firstmateGatewayExecute,
} from "./firstmate-gateway/execute.js";
import {
  testEnvironment as firstmateGatewayTestEnvironment,
} from "./firstmate-gateway/test.js";
import {
  agentConfigurationDoc as firstmateGatewayAgentConfigurationDoc,
  models as firstmateGatewayModels,
} from "./firstmate-gateway/index.js";
```

- [ ] **Step 5: Remove release and workspace coupling**

Remove the FirstMate dependency from `server/package.json`, its object from `scripts/release-package-manifest.json`, and its package-manifest `COPY` line from `Dockerfile`. Run:

```bash
pnpm install --lockfile-only
```

Confirm `pnpm-lock.yaml` no longer contains an importer for `packages/adapters/firstmate-gateway` or a server dependency on `@paperclipai/adapter-firstmate-gateway`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test scripts/firstmate-internal-adapter.test.mjs
pnpm exec tsx --test server/src/adapters/firstmate-gateway/execute.test.ts
pnpm --filter @paperclipai/server typecheck
pnpm test:release-registry
```

Expected: all commands exit `0`; the three existing FirstMate execution tests pass unchanged.

- [ ] **Step 7: Commit the internalization**

```bash
git add Dockerfile server scripts pnpm-lock.yaml packages/adapters/firstmate-gateway
git commit -m "refactor: internalize FirstMate adapter in fork"
```

---

### Task 2: Run complete verification and merge the fork change

**Files:**
- Verify: all files changed by Task 1
- Modify: none unless a verification failure demonstrates a defect in Task 1

**Interfaces:**
- Consumes: the server-internal FirstMate adapter and clean release topology from Task 1.
- Produces: a verified fork commit merged into `voipexpert/paperclip:master` without changing the running production checkout.

- [ ] **Step 1: Verify no active packaging references remain**

Run scoped searches over `server/package.json`, `server/src`, `Dockerfile`, `pnpm-lock.yaml`, and `scripts/release-package-manifest.json`. Expected: zero occurrences of `@paperclipai/adapter-firstmate-gateway` and `packages/adapters/firstmate-gateway`.

- [ ] **Step 2: Run project-required verification**

Run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
docker build --target deps -t paperclip-firstmate-internal-deps-check .
```

Expected: every command exits `0` with no failed tests or build errors.

- [ ] **Step 3: Verify the change set**

Run `git diff origin/master...HEAD --stat`, `git diff --check origin/master...HEAD`, and `git status --short --branch`. Confirm only the approved design, implementation plan, internal adapter move, regression test, dependency metadata, lockfile, release manifest, and Dockerfile changed.

- [ ] **Step 4: Push and merge a fork-local PR**

Push the feature branch to `origin`, create a PR into `voipexpert/paperclip:master` using `.github/PULL_REQUEST_TEMPLATE.md`, verify the PR is mergeable, and merge it. Do not reopen the upstream PR.

- [ ] **Step 5: Reverify fork and production separation**

Confirm GitHub fork `master` equals the PR merge commit. On `plane`, verify `/opt/paperclip/source` remains detached at `e0b482238739efba540d0f8804d4bf6ec572cf5a`, the production container remains running, and `http://127.0.0.1:3100/api/health` returns HTTP `200` with `status: ok`.

