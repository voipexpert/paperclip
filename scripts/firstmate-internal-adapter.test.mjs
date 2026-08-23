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
