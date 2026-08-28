import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildDispatch,
  parseOpenHandsConfig,
  parsePaperclipIssue,
  readGatewayToken,
} from "./contract.js";
import { execute as executeAdapter } from "./execute.js";
import { agentConfigurationDoc } from "./index.js";
import { testEnvironment } from "./test.js";

const tokenDirectories: string[] = [];
const originalTokenFile = process.env.OPENHANDS_GATEWAY_TOKEN_FILE;
const RUN_AUTH_TOKEN = "run-jwt-token";
const TOKEN = "a".repeat(64);
const TOKEN_GID = 4242;
let originalPaperclipApiUrl: string | undefined;

function credentialSecurity(overrides: {
  uid?: number;
  gid?: number;
  groups?: number[];
  tokenUid?: number;
  tokenGid?: number;
  tokenMode?: number;
  afterTokenGid?: number;
  afterTokenMode?: number;
} = {}) {
  let inspections = 0;
  return {
    processUid: overrides.uid ?? 1000,
    processGid: overrides.gid ?? 1000,
    processGroups: overrides.groups ?? [TOKEN_GID],
    inspect(descriptor: number) {
      inspections += 1;
      const value = fstatSync(descriptor);
      return {
        isFile: value.isFile(),
        mode: inspections > 1 && overrides.afterTokenMode !== undefined
          ? overrides.afterTokenMode
          : overrides.tokenMode ?? value.mode,
        uid: overrides.tokenUid ?? 0,
        gid: inspections > 1 && overrides.afterTokenGid !== undefined
          ? overrides.afterTokenGid
          : overrides.tokenGid ?? TOKEN_GID,
        size: value.size,
        dev: value.dev,
        ino: value.ino,
        nlink: value.nlink,
        mtimeMs: value.mtimeMs,
      };
    },
  };
}

const execute = (value: Parameters<typeof executeAdapter>[0]) => executeAdapter(value, credentialSecurity());

beforeEach(() => {
  originalPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalTokenFile === undefined) delete process.env.OPENHANDS_GATEWAY_TOKEN_FILE;
  else process.env.OPENHANDS_GATEWAY_TOKEN_FILE = originalTokenFile;
  if (originalPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = originalPaperclipApiUrl;
  await Promise.all(tokenDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setGatewayToken(value = TOKEN, mode = 0o640): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openhands-gateway-"));
  tokenDirectories.push(directory);
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, value, { mode });
  await chmod(tokenFile, mode);
  process.env.OPENHANDS_GATEWAY_TOKEN_FILE = tokenFile;
}

function context(port: number, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-oh",
      companyId: "company-1",
      name: "OpenHands",
      adapterType: "openhands_gateway",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      url: `ws://127.0.0.1:${port}/paperclip-worker/v1`,
      timeoutSec: 3,
      projectTargets: {
        "project-acceptance": {
          repository: "voipexpert/openhands-worker-acceptance",
          baseRef: "main",
          profile: "openhands",
        },
      },
    },
    context: {
      paperclipIssue: {
        id: "task-1",
        status: "in_progress",
        assigneeAgentId: "agent-oh",
        projectId: "project-acceptance",
        title: "Canary",
        description: "Make the bounded canary change.",
      },
    },
    authToken: RUN_AUTH_TOKEN,
    onLog: async () => {},
    ...overrides,
  };
}

function completedEvidence() {
  const branchDigest = createHash("sha256").update("task-1\0run-1", "utf8").digest("hex").slice(0, 20);
  return {
    version: 1,
    repository: "voipexpert/openhands-worker-acceptance",
    base_ref: "main",
    branch: `openhands/pc-${branchDigest}`,
    commit: "a".repeat(40),
    tests: [{ name: "pnpm test", status: "passed" }],
    draft_pr: { number: 1, url: "https://github.com/voipexpert/openhands-worker-acceptance/pull/1" },
    summary: "Bounded canary completed.",
  };
}

function noChangeEvidence() {
  return {
    version: 1, outcome: "no_change", repository: "voipexpert/openhands-worker-acceptance", base_ref: "main",
    commit: "b".repeat(40), tests: [{ name: "pnpm test", status: "passed" }], summary: "No change required.",
  };
}

async function gateway(handler: (socket: import("ws").WebSocket, request: import("node:http").IncomingMessage) => void) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function paperclipApi(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<void> | void,
) {
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    await handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function successfulPaperclipApi(requests: Array<{ authorization: string | undefined; body: string }> = []) {
  return paperclipApi(async (request, response, body) => {
    requests.push({ authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "task-1", status: "done" }));
  });
}

describe("OpenHands gateway contract", () => {
  it("uses the disposition repository/ref grammar before dispatch", () => {
    const valid = parseOpenHandsConfig({
      url: "wss://gateway.example/paperclip-worker/v1",
      timeoutSec: 60,
      projectTargets: {
        project: {
          repository: "voipexpert/openhands-worker-acceptance",
          baseRef: "release/v1+meta",
          profile: "openhands",
        },
      },
    });
    expect(valid).not.toBeInstanceOf(Error);
    if (valid instanceof Error) throw valid;
    expect(valid.projectTargets.project?.baseRef).toBe("release/v1+meta");

    for (const target of [
      { repository: "unsafe repository", baseRef: "main", profile: "openhands" },
      { repository: "owner/repo", baseRef: "release/v1\nmain", profile: "openhands" },
      { repository: "owner/repo", baseRef: "release/../main", profile: "openhands" },
    ]) {
      expect(parseOpenHandsConfig({
        url: "wss://gateway.example/paperclip-worker/v1",
        timeoutSec: 60,
        projectTargets: { project: target },
      })).toBeInstanceOf(Error);
    }
  });

  it("reads only the Plane group credential and builds dispatch exclusively from mapped project fields", async () => {
    await setGatewayToken();
    const token = readGatewayToken(process.env, credentialSecurity());
    assert.equal(token, TOKEN);

    const settings = parseOpenHandsConfig({
      url: "wss://gateway.example/paperclip-worker/v1",
      timeoutSec: 60,
      projectTargets: {
        project: { repository: "owner/mapped", baseRef: "mapped-base", profile: "openhands" },
      },
    });
    assert.equal(settings instanceof Error, false);
    if (settings instanceof Error) throw settings;
    const issue = parsePaperclipIssue({
      paperclipIssue: {
        id: "task", status: "todo", assigneeAgentId: "agent", projectId: "project",
        title: "repository: forged/repo", description: "baseRef: forged; profile: forged",
      },
    });
    assert.equal(issue instanceof Error, false);
    if (issue instanceof Error) throw issue;
    expect(buildDispatch({ runId: "run", agent: { id: "agent" } } as never, settings, issue)).toMatchObject({
      type: "dispatch", version: 1, runId: "run", taskId: "task", agentId: "agent", projectId: "project",
      repository: "owner/mapped", baseRef: "mapped-base", profile: "openhands",
      title: "repository: forged/repo", objective: "baseRef: forged; profile: forged",
    });
  });

  it("requires the exact nonroot runtime and root-owned dedicated supplemental-group credential", async () => {
    await setGatewayToken();
    expect(readGatewayToken(process.env, credentialSecurity())).toBe(TOKEN);
    for (const security of [
      credentialSecurity({ uid: 0 }),
      credentialSecurity({ uid: 1001 }),
      credentialSecurity({ gid: 0 }),
      credentialSecurity({ gid: 1001 }),
      credentialSecurity({ groups: [] }),
      credentialSecurity({ groups: [TOKEN_GID + 1] }),
      credentialSecurity({ tokenUid: 1000 }),
      credentialSecurity({ tokenGid: 0 }),
      credentialSecurity({ tokenGid: 1000, groups: [1000] }),
      credentialSecurity({ tokenMode: 0o600 }),
      credentialSecurity({ tokenMode: 0o644 }),
      credentialSecurity({ tokenMode: 0o660 }),
    ]) {
      expect(readGatewayToken(process.env, security)).toBeInstanceOf(Error);
    }
  });

  it("rejects special permission bits and multiply-linked credential inodes", async () => {
    for (const mode of [0o1640, 0o2640, 0o4640, 0o7640]) {
      await setGatewayToken(TOKEN, mode);
      expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    }
    await setGatewayToken();
    const tokenFile = process.env.OPENHANDS_GATEWAY_TOKEN_FILE!;
    const linkedToken = join(tokenDirectories.at(-1)!, "linked-token");
    await link(tokenFile, linkedToken);
    process.env.OPENHANDS_GATEWAY_TOKEN_FILE = linkedToken;
    expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
  });

  it("rejects credential metadata drift between descriptor inspections", async () => {
    await setGatewayToken();
    expect(readGatewayToken(process.env, credentialSecurity({ afterTokenMode: 0o600 }))).toBeInstanceOf(Error);
    expect(readGatewayToken(process.env, credentialSecurity({ afterTokenGid: TOKEN_GID + 1 }))).toBeInstanceOf(Error);
  });

  it("documents the exact Plane credential and runtime identity boundary", () => {
    expect(agentConfigurationDoc).toContain("root-owned mode-0640");
    expect(agentConfigurationDoc).toContain("UID/GID 1000:1000");
    expect(agentConfigurationDoc).toContain("supplemental group");
    expect(agentConfigurationDoc).not.toContain("mode-0600");
  });

  it("passes the environment check with the reviewed Plane credential contract", async () => {
    await setGatewayToken();
    const remote = await gateway((socket) => socket.send(JSON.stringify({ type: "hello", version: 1 })));
    try {
      const result = await testEnvironment({ config: context(remote.port).config } as never, credentialSecurity());
      expect(result).toMatchObject({ adapterType: "openhands_gateway", status: "pass" });
    } finally {
      await remote.close();
    }
  });

  it("rejects runtime skills when execute is called directly", async () => {
    await setGatewayToken();
    const base = context(1);
    const runtimeSkills = [{ key: "company/review", runtimeName: "review", source: "managed" }];
    const liveContext = {
      ...base,
      config: { ...base.config, paperclipRuntimeSkills: runtimeSkills },
    };

    expect(parseOpenHandsConfig(liveContext.config)).toBeInstanceOf(Error);
    await expect(execute(liveContext)).resolves.toMatchObject({ errorCode: "OPENHANDS_CONFIG" });
  });

  it("rejects an operator unknown key when execute is called directly", async () => {
    await setGatewayToken();
    const base = context(1);
    const unknownContext = {
      ...base,
      config: { ...base.config, operatorUnknown: true },
    };
    await expect(execute(unknownContext)).resolves.toMatchObject({ errorCode: "OPENHANDS_CONFIG" });
  });

  it("rejects an operator env key when execute is called directly", async () => {
    await setGatewayToken();
    const base = context(1);
    const envContext = {
      ...base,
      config: { ...base.config, env: {} },
    };
    await expect(execute(envContext)).resolves.toMatchObject({ errorCode: "OPENHANDS_CONFIG" });
  });

  it("preserves exact gateway credential bytes and rejects whitespace framing", async () => {
    await setGatewayToken(TOKEN);
    expect(readGatewayToken(process.env, credentialSecurity())).toBe(TOKEN);
    for (const token of [`${TOKEN}\r`, `${TOKEN}\n`, ` ${TOKEN}`, `${TOKEN} `, `\t${TOKEN}`, `${TOKEN}\t`]) {
      await setGatewayToken(token);
      expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    }
  });

  it("rejects malformed or BOM-framed UTF-8 credentials without normalizing valid decomposed text", async () => {
    await setGatewayToken(TOKEN);
    expect(readGatewayToken(process.env, credentialSecurity())).toBe(TOKEN);
    const tokenDirectory = tokenDirectories.at(-1)!;
    for (const [name, bytes] of [["bom", Buffer.from([0xef, 0xbb, 0xbf, 0x74])], ["malformed", Buffer.from([0xc3, 0x28])]] as const) {
      const tokenFile = join(tokenDirectory, name);
      await writeFile(tokenFile, bytes, { mode: 0o640 });
      await chmod(tokenFile, 0o640);
      process.env.OPENHANDS_GATEWAY_TOKEN_FILE = tokenFile;
      expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    }
  });

  it("accepts only exact lowercase 64-hex credential vectors", async () => {
    for (const token of ["b".repeat(64), "0".repeat(64)]) {
      await setGatewayToken(token);
      expect(readGatewayToken(process.env, credentialSecurity())).toBe(token);
    }
    for (const token of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`]) {
      await setGatewayToken(token);
      expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    }
  });

  it("accepts the existing redacted heartbeat issue fields alongside the OpenHands contract fields", () => {
    const issue = parsePaperclipIssue({
      paperclipIssue: {
        id: "task", identifier: "PC-1", status: "todo", assigneeAgentId: "agent", projectId: "project",
        title: "title", description: "objective", workMode: "implementation",
      },
    });
    expect(issue).not.toBeInstanceOf(Error);
  });

  it("rejects unsafe tokens and all invalid config or issue input", async () => {
    await setGatewayToken("test-token", 0o644);
    expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    const tokenDirectory = tokenDirectories.at(-1)!;
    const emptyToken = join(tokenDirectory, "empty-token");
    const oversizedToken = join(tokenDirectory, "oversized-token");
    const tokenLink = join(tokenDirectory, "token-link");
    await writeFile(emptyToken, "", { mode: 0o640 });
    await writeFile(oversizedToken, "x".repeat(4_097), { mode: 0o640 });
    await symlink(join(tokenDirectory, "token"), tokenLink);
    for (const tokenFile of [emptyToken, oversizedToken, tokenLink]) {
      process.env.OPENHANDS_GATEWAY_TOKEN_FILE = tokenFile;
      expect(readGatewayToken(process.env, credentialSecurity())).toBeInstanceOf(Error);
    }

    const validConfig = {
      url: "wss://gateway.example/paperclip-worker/v1", timeoutSec: 60,
      projectTargets: { project: { repository: "owner/repo", baseRef: "main", profile: "openhands" } },
    };
    for (const config of [
      { ...validConfig, authToken: "forbidden" },
      { ...validConfig, paperclipRuntimeSkills: [] },
      { ...validConfig, url: "https://gateway.example" },
      { ...validConfig, url: "ws://gateway.example" },
      { ...validConfig, url: "wss://gateway.example/paperclip-worker/v1#fragment" },
      { ...validConfig, url: `wss://${"a".repeat(2_049)}.example/paperclip-worker/v1` },
      { ...validConfig, projectTargets: {} },
      { ...validConfig, projectTargets: { project: { ...validConfig.projectTargets.project, extra: true } } },
    ]) expect(parseOpenHandsConfig(config)).toBeInstanceOf(Error);
    const clamped = parseOpenHandsConfig({ ...validConfig, timeoutSec: 3 });
    assert.equal(clamped instanceof Error, false);
    if (!(clamped instanceof Error)) assert.equal(clamped.timeoutMs, 60_000);
    const upperClamped = parseOpenHandsConfig({ ...validConfig, timeoutSec: 7_201 });
    assert.equal(upperClamped instanceof Error, false);
    if (!(upperClamped instanceof Error)) assert.equal(upperClamped.timeoutMs, 7_200_000);

    const validIssue = {
      id: "task", status: "in_progress", assigneeAgentId: "agent", projectId: "project", title: "title", description: "objective",
    };
    for (const issue of [
      {},
      { ...validIssue, status: "done" },
      { ...validIssue, title: "x".repeat(301) },
      { ...validIssue, description: "x".repeat(20_001) },
    ]) {
      const parsed = parsePaperclipIssue({ paperclipIssue: issue });
      if (issue === validIssue) continue;
      expect(parsed).toBeInstanceOf(Error);
    }
  });

  it("rejects taskless, non-actionable, wrongly assigned, and unmapped heartbeats before connecting", async () => {
    await setGatewayToken();
    const invalidContexts = [
      context(1, { context: {} }),
      context(1, { context: { paperclipIssue: { ...context(1).context.paperclipIssue, status: "done" } } }),
      context(1, { context: { paperclipIssue: { ...context(1).context.paperclipIssue, assigneeAgentId: "other" } } }),
      context(1, { context: { paperclipIssue: { ...context(1).context.paperclipIssue, projectId: "unknown" } } }),
    ];
    for (const invalidContext of invalidContexts) {
      const result = await execute(invalidContext);
      expect(result).toMatchObject({ exitCode: 1, timedOut: false });
      expect(result.errorCode).toMatch(/^OPENHANDS_/);
    }
  });

  it("authenticates, sends the exact dispatch, ignores mismatched frames, and returns completed gateway evidence", async () => {
    await setGatewayToken();
    const logs: Array<[string, string]> = [];
    const received: Record<string, unknown>[] = [];
    const dispositionRequests: Array<{ authorization: string | undefined; body: string }> = [];
    const api = await successfulPaperclipApi(dispositionRequests);
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket, request) => {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(frame);
        if (frame.type !== "dispatch") return;
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: "other", taskId: frame.taskId, agentId: frame.agentId, status: "completed", result: completedEvidence() }));
        socket.send(JSON.stringify({ type: "run_event", version: 1, runId: frame.runId, taskId: "other", agentId: frame.agentId, state: "running", timestamp: "2026-08-27T12:00:00.000Z" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: "other", status: "completed", result: completedEvidence() }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, status: "completed", result: completedEvidence() }));
      });
    });
    try {
      const result = await execute({ ...context(testGateway.port), onLog: async (stream, line) => { logs.push([stream, line]); } });
      expect(received).toEqual([{
        type: "dispatch", version: 1, runId: "run-1", taskId: "task-1", agentId: "agent-oh", projectId: "project-acceptance",
        repository: "voipexpert/openhands-worker-acceptance", baseRef: "main", profile: "openhands",
        title: "Canary", objective: "Make the bounded canary change.",
      }]);
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, resultJson: completedEvidence() });
      expect(dispositionRequests).toHaveLength(1);
      expect(dispositionRequests[0]?.authorization).toBe(`Bearer ${RUN_AUTH_TOKEN}`);
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"], ["stdout", "OpenHands gateway completed.\n"]]);
    } finally {
      await testGateway.close();
      await api.close();
    }
  });

  it("waits for confirmed Paperclip completion before adapter success or completion logging", async () => {
    await setGatewayToken();
    const logs: Array<[string, string]> = [];
    let releaseDisposition!: () => void;
    const dispositionReleased = new Promise<void>((resolve) => { releaseDisposition = resolve; });
    let dispositionSeen!: () => void;
    const dispositionReceived = new Promise<void>((resolve) => { dispositionSeen = resolve; });
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const api = await paperclipApi(async (request, response, body) => {
      requests.push({ authorization: request.headers.authorization, body });
      dispositionSeen();
      await dispositionReleased;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-1", status: "done" }));
    });
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
      });
    });
    try {
      const resultPromise = execute({ ...context(testGateway.port), onLog: async (stream, line) => { logs.push([stream, line]); } });
      let settled = false;
      void resultPromise.then(() => { settled = true; });
      await expect(Promise.race([
        dispositionReceived.then(() => "patched"),
        resultPromise.then(() => "settled"),
      ])).resolves.toBe("patched");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"]]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${RUN_AUTH_TOKEN}`);
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
        outcome: "change",
        repository: "voipexpert/openhands-worker-acceptance",
        baseRef: "main",
        commit: "a".repeat(40),
      });

      releaseDisposition();

      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0, timedOut: false, resultJson: completedEvidence() });
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"], ["stdout", "OpenHands gateway completed.\n"]]);
    } finally {
      releaseDisposition?.();
      await testGateway.close();
      await api.close();
    }
  });

  it("issues exactly one disposition POST for duplicate completed frames", async () => {
    await setGatewayToken();
    let releaseDisposition!: () => void;
    const dispositionReleased = new Promise<void>((resolve) => { releaseDisposition = resolve; });
    let firstDispositionSeen!: () => void;
    const firstDispositionReceived = new Promise<void>((resolve) => { firstDispositionSeen = resolve; });
    let duplicateSent!: () => void;
    const duplicateCompletedFrameSent = new Promise<void>((resolve) => { duplicateSent = resolve; });
    let duplicateFrameObserved!: () => void;
    const duplicateFrameObservation = new Promise<void>((resolve) => { duplicateFrameObserved = resolve; });
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const api = await paperclipApi(async (request, response, body) => {
      requests.push({ authorization: request.headers.authorization, body });
      firstDispositionSeen();
      await dispositionReleased;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-1", status: "done" }));
    });
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
        setImmediate(() => {
          socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
          duplicateSent();
          socket.ping();
        });
        socket.on("pong", () => duplicateFrameObserved());
      });
    });
    try {
      const resultPromise = execute(context(testGateway.port));
      await firstDispositionReceived;
      await duplicateCompletedFrameSent;
      await duplicateFrameObservation;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${RUN_AUTH_TOKEN}`);
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
        outcome: "change",
        repository: "voipexpert/openhands-worker-acceptance",
        baseRef: "main",
        commit: "a".repeat(40),
      });

      releaseDisposition();

      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0, timedOut: false, resultJson: completedEvidence() });
      expect(requests).toHaveLength(1);
    } finally {
      releaseDisposition?.();
      await testGateway.close();
      await api.close();
    }
  });

  it("ignores malformed frames and contradictory acknowledgements after validated completion starts disposition", async () => {
    await setGatewayToken();
    const logs: Array<[string, string]> = [];
    let releaseDisposition!: () => void;
    const dispositionReleased = new Promise<void>((resolve) => { releaseDisposition = resolve; });
    let dispositionSeen!: () => void;
    const dispositionReceived = new Promise<void>((resolve) => { dispositionSeen = resolve; });
    let laterFramesObserved!: () => void;
    const laterFrameObservation = new Promise<void>((resolve) => { laterFramesObserved = resolve; });
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const api = await paperclipApi(async (request, response, body) => {
      requests.push({ authorization: request.headers.authorization, body });
      dispositionSeen();
      await dispositionReleased;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-1", status: "done" }));
    });
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
        setImmediate(() => {
          socket.send("{");
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: false, reason: "busy" }));
          socket.send(JSON.stringify({ type: "run_event", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, state: "running", timestamp: "invalid" }));
          socket.ping();
        });
        socket.on("pong", () => laterFramesObserved());
      });
    });
    try {
      const resultPromise = execute({ ...context(testGateway.port), onLog: async (stream, line) => { logs.push([stream, line]); } });
      await dispositionReceived;
      await laterFrameObservation;
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"]]);
      releaseDisposition();
      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0, timedOut: false, resultJson: completedEvidence() });
      expect(requests).toHaveLength(1);
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"], ["stdout", "OpenHands gateway completed.\n"]]);
    } finally {
      releaseDisposition?.();
      await testGateway.close();
      await api.close();
    }
  });

  it("settles successfully when completion logging rejects after disposition", async () => {
    await setGatewayToken();
    const api = await successfulPaperclipApi();
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
      });
    });
    try {
      let completionLogAttempted!: () => void;
      const completionLogAttempt = new Promise<void>((resolve) => { completionLogAttempted = resolve; });
      const resultPromise = execute({ ...context(testGateway.port), onLog: async (_stream, line) => {
          if (line === "OpenHands gateway completed.\n") {
            completionLogAttempted();
            throw new Error("logging unavailable");
          }
        } });
      await completionLogAttempt;
      await expect(resultPromise).resolves.toEqual({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: completedEvidence(),
      });
    } finally {
      await testGateway.close();
      await api.close();
    }
  });

  it("accepts the documented exact lifecycle frames and terminal completed evidence", async () => {
    await setGatewayToken();
    const api = await successfulPaperclipApi();
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({
          type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId,
          agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted",
        }));
        socket.send(JSON.stringify({
          type: "run_event", version: 1, runId: dispatch.runId, taskId: dispatch.taskId,
          agentId: dispatch.agentId, state: "running", timestamp: "2026-08-27T12:00:00.000Z",
        }));
        socket.send(JSON.stringify({
          type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId,
          agentId: dispatch.agentId, status: "completed", result: completedEvidence(),
        }));
      });
    });
    try {
      await expect(execute(context(testGateway.port))).resolves.toMatchObject({
        exitCode: 0,
        resultJson: completedEvidence(),
      });
    } finally {
      await testGateway.close();
      await api.close();
    }
  });

  it("accepts the exact Hermes no-change success evidence union", async () => {
    await setGatewayToken();
    const api = await successfulPaperclipApi();
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: noChangeEvidence() }));
      });
    });
    try { await expect(execute(context(testGateway.port))).resolves.toMatchObject({ exitCode: 0, resultJson: noChangeEvidence() }); }
    finally {
      await testGateway.close();
      await api.close();
    }
  });

  async function expectDispositionFailure(
    overrides: Record<string, unknown>,
    requests: string[],
  ) {
    await setGatewayToken();
    const logs: Array<[string, string]> = [];
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
      });
    });
    try {
      const result = await execute({
        ...context(testGateway.port),
        ...overrides,
        onLog: async (stream, line) => { logs.push([stream, line]); },
      });
      expect(result).toEqual({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "OPENHANDS_DISPOSITION",
        errorMessage: "OpenHands gateway issue disposition failed.",
      });
      expect(JSON.stringify(result)).not.toContain(RUN_AUTH_TOKEN);
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"]]);
      return { result, logs };
    } finally {
      await testGateway.close();
    }
  }

  it("maps missing run auth to a fixed disposition failure", async () => {
    const requests: string[] = [];
    const api = await paperclipApi(async (request, response, body) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""} ${body}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-1", status: "done" }));
    });
    process.env.PAPERCLIP_API_URL = api.url;
    try {
      await expectDispositionFailure({ authToken: undefined }, requests);
      expect(requests).toHaveLength(0);
    } finally {
      await api.close();
    }
  });

  it("maps a missing Paperclip API URL to a fixed disposition failure", async () => {
    const requests: string[] = [];
    delete process.env.PAPERCLIP_API_URL;

    await expectDispositionFailure({}, requests);

    expect(requests).toHaveLength(0);
  });

  it("maps a rejected disposition client request to a fixed disposition failure", async () => {
    const requests: string[] = [];
    const dispositionDetail = "untrusted Paperclip disposition detail";
    const api = await paperclipApi(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(dispositionDetail);
    });
    process.env.PAPERCLIP_API_URL = api.url;
    try {
      const outcome = await expectDispositionFailure({}, requests);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(outcome)).not.toContain(dispositionDetail);
    } finally {
      await api.close();
    }
  });

  it.each([
    {
      name: "dispatch rejection for busy",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_BUSY" },
      expectedLogs: [["stderr", "OpenHands gateway dispatch rejected.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: false, reason: "busy" }));
      },
    },
    {
      name: "dispatch rejection for validation",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_REJECTED" },
      expectedLogs: [["stderr", "OpenHands gateway dispatch rejected.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: false, reason: "validation" }));
      },
    },
    {
      name: "a failed terminal result",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_FAILED", resultJson: { state: "failed", reason: "validation" } },
      expectedLogs: [["stdout", "OpenHands gateway dispatch accepted.\n"], ["stderr", "OpenHands gateway failed.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "failed", result: { code: "validation" } }));
      },
    },
    {
      name: "a cancelled terminal result",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_CANCELLED", resultJson: { state: "cancelled", reason: "cancelled_by_request" } },
      expectedLogs: [["stdout", "OpenHands gateway dispatch accepted.\n"], ["stderr", "OpenHands gateway cancelled.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "cancelled", result: { code: "cancelled_by_request" } }));
      },
    },
    {
      name: "a timed_out terminal result",
      expected: { exitCode: 1, timedOut: true, errorCode: "OPENHANDS_TIMEOUT", resultJson: { state: "timed_out", reason: "timeout" } },
      expectedLogs: [["stdout", "OpenHands gateway dispatch accepted.\n"], ["stderr", "OpenHands gateway timed_out.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "timed_out", result: { code: "timeout" } }));
      },
    },
    {
      name: "an indeterminate terminal result",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_INDETERMINATE", clearSession: false, resultJson: { state: "indeterminate", reason: "gateway_indeterminate" } },
      expectedLogs: [["stdout", "OpenHands gateway dispatch accepted.\n"]],
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "indeterminate", result: { code: "indeterminate" } }));
      },
    },
  ])("does not disposition for %s", async ({ expected, expectedLogs, send }) => {
    await setGatewayToken();
    const logs: Array<[string, string]> = [];
    const requests: string[] = [];
    const api = await paperclipApi(async (request, response, body) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""} ${body}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-1", status: "done" }));
    });
    process.env.PAPERCLIP_API_URL = api.url;
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw)) as Record<string, unknown>;
        send(socket, dispatch);
      });
    });
    try {
      await expect(execute({ ...context(testGateway.port), onLog: async (stream, line) => { logs.push([stream, line]); } })).resolves.toMatchObject(expected);
      expect(logs).toEqual(expectedLogs);
      expect(requests).toHaveLength(0);
    } finally {
      await testGateway.close();
      await api.close();
    }
  });

  it.each([
    {
      name: "a rejected acknowledgement",
      expected: { exitCode: 1, timedOut: false, errorCode: "OPENHANDS_REJECTED" },
      terminalLog: "OpenHands gateway dispatch rejected.\n",
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({
          type: "dispatch_ack",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          accepted: false,
          reason: "validation",
        }));
      },
    },
    {
      name: "a failed terminal result",
      expected: {
        exitCode: 1,
        timedOut: false,
        errorCode: "OPENHANDS_FAILED",
        resultJson: { state: "failed", reason: "validation" },
      },
      terminalLog: "OpenHands gateway failed.\n",
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({
          type: "dispatch_ack",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          accepted: true,
          duplicate: false,
          state: "accepted",
        }));
        socket.send(JSON.stringify({
          type: "run_result",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          status: "failed",
          result: { code: "validation" },
        }));
      },
    },
    {
      name: "a cancelled terminal result",
      expected: {
        exitCode: 1,
        timedOut: false,
        errorCode: "OPENHANDS_CANCELLED",
        resultJson: { state: "cancelled", reason: "cancelled_by_request" },
      },
      terminalLog: "OpenHands gateway cancelled.\n",
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({
          type: "dispatch_ack",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          accepted: true,
          duplicate: false,
          state: "accepted",
        }));
        socket.send(JSON.stringify({
          type: "run_result",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          status: "cancelled",
          result: { code: "cancelled_by_request" },
        }));
      },
    },
    {
      name: "a timed-out terminal result",
      expected: {
        exitCode: 1,
        timedOut: true,
        errorCode: "OPENHANDS_TIMEOUT",
        resultJson: { state: "timed_out", reason: "timeout" },
      },
      terminalLog: "OpenHands gateway timed_out.\n",
      send: (socket: import("ws").WebSocket, dispatch: Record<string, unknown>) => {
        socket.send(JSON.stringify({
          type: "dispatch_ack",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          accepted: true,
          duplicate: false,
          state: "accepted",
        }));
        socket.send(JSON.stringify({
          type: "run_result",
          version: 1,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          agentId: dispatch.agentId,
          status: "timed_out",
          result: { code: "timeout" },
        }));
      },
    },
  ])("settles $name when terminal logging rejects", async ({ expected, terminalLog, send }) => {
    await setGatewayToken();
    const logRejectionDetail = "private logging backend detail";
    let terminalLogSeen!: () => void;
    const terminalLogAttempted = new Promise<void>((resolve) => { terminalLogSeen = resolve; });
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw)) as Record<string, unknown>;
        send(socket, dispatch);
      });
    });
    try {
      const resultPromise = execute({
        ...context(testGateway.port),
        onLog: async (_stream, line) => {
          if (line !== terminalLog) return;
          terminalLogSeen();
          throw new Error(logRejectionDetail);
        },
      });
      await terminalLogAttempted;
      const terminalResult = await resultPromise;
      expect(terminalResult).toMatchObject(expected);
      expect(JSON.stringify(terminalResult)).not.toContain(logRejectionDetail);
    } finally {
      await testGateway.close();
    }
  });

  it.each([
    ["failed", "validation", "OPENHANDS_FAILED"],
    ["cancelled", "cancelled_by_request", "OPENHANDS_CANCELLED"],
    ["timed_out", "timeout", "OPENHANDS_TIMEOUT"],
  ] as const)("latches a %s terminal frame before logging so later completion cannot disposition", async (status, code, errorCode) => {
    await setGatewayToken();
    const dispositionRequest = vi.fn(async () => new Response(
      JSON.stringify({ id: "task-1", status: "done" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", dispositionRequest);
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
    let gatewaySocket!: import("ws").WebSocket;
    let terminalLogSeen!: () => void;
    const terminalLogAttempted = new Promise<void>((resolve) => { terminalLogSeen = resolve; });
    let releaseTerminalLog!: () => void;
    const terminalLogReleased = new Promise<void>((resolve) => { releaseTerminalLog = resolve; });
    const testGateway = await gateway((socket) => {
      gatewaySocket = socket;
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status, result: { code } }));
      });
    });
    try {
      const resultPromise = execute({
        ...context(testGateway.port),
        onLog: async (stream) => {
          if (stream === "stderr") {
            terminalLogSeen();
            await terminalLogReleased;
          }
        },
      });
      await terminalLogAttempted;
      gatewaySocket.send(JSON.stringify({
        type: "run_result",
        version: 1,
        runId: "run-1",
        taskId: "task-1",
        agentId: "agent-oh",
        status: "completed",
        result: completedEvidence(),
      }));
      const completionFrameObserved = new Promise<void>((resolve) => gatewaySocket.once("pong", () => resolve()));
      gatewaySocket.ping();
      await Promise.race([completionFrameObserved, resultPromise.then(() => undefined)]);
      expect(dispositionRequest).not.toHaveBeenCalled();
      releaseTerminalLog();
      await expect(resultPromise).resolves.toMatchObject({ errorCode });
    } finally {
      releaseTerminalLog?.();
      await testGateway.close();
    }
  });

  it("rejects a contradictory rejected acknowledgement after acceptance", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: false, reason: "busy" }));
      });
    });
    try { await expect(execute(context(testGateway.port))).resolves.toMatchObject({ errorCode: "OPENHANDS_PROTOCOL", clearSession: false }); }
    finally { await testGateway.close(); }
  });

  it("rejects wrong-version correlated frames and evidence keys outside the terminal allowlist", async () => {
    await setGatewayToken();
    for (const invalidCase of ["wrong-version", "leaky-evidence"] as const) {
      const testGateway = await gateway((socket) => {
        socket.send(JSON.stringify({ type: "hello", version: 1 }));
        socket.on("message", (raw) => {
          const dispatch = JSON.parse(String(raw));
          socket.send(JSON.stringify({ type: "dispatch_ack", version: invalidCase === "wrong-version" ? 2 : 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
          if (invalidCase === "leaky-evidence") socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "indeterminate", result: { code: "indeterminate", leaked: "forbidden" } }));
        });
      });
      try {
        await expect(execute(context(testGateway.port))).resolves.toMatchObject({ errorCode: "OPENHANDS_PROTOCOL" });
      } finally { await testGateway.close(); }
    }
  });

  it("returns bounded fixed errors for rejected, malformed, and non-completed terminal results without leaking gateway data", async () => {
    await setGatewayToken();
    for (const response of [
      { type: "dispatch_ack", accepted: false, reason: "busy" },
      { type: "run_result", status: "completed", result: "not evidence" },
      { type: "run_result", status: "failed", result: { details: "do not leak this exception body" } },
      { type: "run_result", status: "cancelled", result: {} },
    ]) {
      const logs: string[] = [];
      const testGateway = await gateway((socket) => {
        socket.send(JSON.stringify({ type: "hello", version: 1 }));
        socket.on("message", (raw) => {
          const dispatch = JSON.parse(String(raw));
          socket.send(JSON.stringify({
            ...response, version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId,
            accepted: response.type === "dispatch_ack" ? false : undefined,
          }));
        });
      });
      try {
        const result = await execute({ ...context(testGateway.port), onLog: async (_stream, line) => { logs.push(line); } });
        expect(result.exitCode).toBe(1);
        expect(result.errorCode).toMatch(/^OPENHANDS_/);
        expect(result.errorMessage).not.toContain("exception body");
        expect(logs.every((line) => /^OpenHands gateway (dispatch rejected|protocol failure|failed|cancelled)\.\n$/.test(line))).toBe(true);
      } finally { await testGateway.close(); }
    }
  });

  it("rejects a terminal result received before dispatch acceptance", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
      });
    });
    try {
      await expect(execute(context(testGateway.port))).resolves.toMatchObject({ exitCode: 1, errorCode: "OPENHANDS_PROTOCOL" });
    } finally { await testGateway.close(); }
  });

  it("records an acknowledged disconnect as indeterminate without clearing session state", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.close();
      });
    });
    try {
      await expect(execute(context(testGateway.port))).resolves.toMatchObject({
        exitCode: 1,
        timedOut: false,
        errorCode: "OPENHANDS_INDETERMINATE",
        clearSession: false,
        resultJson: { state: "indeterminate", reason: "post_dispatch_disconnect" },
      });
    } finally { await testGateway.close(); }
  });

  it("records a close after dispatch send but before acknowledgement as indeterminate", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", () => socket.close());
    });
    try {
      await expect(execute(context(testGateway.port))).resolves.toMatchObject({
        errorCode: "OPENHANDS_INDETERMINATE",
        clearSession: false,
        resultJson: { state: "indeterminate", reason: "post_dispatch_disconnect" },
      });
    } finally { await testGateway.close(); }
  });

  it("records a socket error after dispatch send but before acknowledgement as indeterminate", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", () => {
        const transport = socket as unknown as { _socket: { write: (data: Uint8Array) => boolean } };
        transport._socket.write(Buffer.from([0x81, 0x80, 0x00, 0x00, 0x00, 0x00]));
      });
    });
    try {
      await expect(execute(context(testGateway.port))).resolves.toMatchObject({
        errorCode: "OPENHANDS_INDETERMINATE",
        clearSession: false,
        resultJson: { state: "indeterminate", reason: "post_dispatch_disconnect" },
      });
    } finally { await testGateway.close(); }
  });

  it("rejects frames with unexpected fields or unbounded terminal evidence", async () => {
    await setGatewayToken();
    const cases: Array<{ name: string; onConnect: (socket: import("ws").WebSocket, dispatch?: Record<string, unknown>) => void }> = [
      { name: "hello", onConnect: (socket) => socket.send(JSON.stringify({ type: "hello", version: 1, extra: true })) },
      { name: "ack", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, accepted: true, duplicate: false, state: "accepted", extra: true })) },
      { name: "event", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "run_event", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, state: "running", timestamp: "2026-08-27T12:00:00.000Z", extra: true })) },
      { name: "result", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, status: "completed", result: { summary: "x".repeat(4_097) } })) },
    ];
    for (const testCase of cases) {
      const testGateway = await gateway((socket) => {
        if (testCase.name === "hello") { testCase.onConnect(socket); return; }
        socket.send(JSON.stringify({ type: "hello", version: 1 }));
        socket.on("message", (raw) => {
          const dispatch = JSON.parse(String(raw));
          if (testCase.name !== "ack") socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
          testCase.onConnect(socket, dispatch);
          if (testCase.name === "ack" || testCase.name === "event") socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: completedEvidence() }));
        });
      });
      try {
        await expect(execute(context(testGateway.port))).resolves.toMatchObject({ errorCode: "OPENHANDS_PROTOCOL" });
      } finally { await testGateway.close(); }
    }
  });

  it("sends one matching cancel at its absolute deadline and preserves a gateway timed_out terminal", async () => {
    await setGatewayToken();
    const received: Record<string, unknown>[] = [];
    let dispatchSeen!: () => void;
    const dispatchReceived = new Promise<void>((resolve) => { dispatchSeen = resolve; });
    let acceptanceSeen!: () => void;
    const acceptanceLogged = new Promise<void>((resolve) => { acceptanceSeen = resolve; });
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(frame);
        if (frame.type === "dispatch") {
          dispatchSeen();
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true, duplicate: false, state: "accepted" }));
        }
        if (frame.type === "cancel") socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, status: "timed_out", result: { code: "timeout" } }));
      });
    });
    try {
      vi.useFakeTimers();
      const resultPromise = execute({
        ...context(testGateway.port),
        onLog: async (_stream, line) => {
          if (line === "OpenHands gateway dispatch accepted.\n") acceptanceSeen();
        },
      });
      await dispatchReceived;
      await acceptanceLogged;
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;
      expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "OPENHANDS_TIMEOUT" });
      expect(received.filter((frame) => frame.type === "cancel")).toEqual([{ type: "cancel", version: 1, runId: "run-1", taskId: "task-1", agentId: "agent-oh" }]);
    } finally { vi.useRealTimers(); await testGateway.close(); }
  });

  it("never dispositions completion delivered after local deadline cancellation begins", async () => {
    await setGatewayToken();
    const dispositionRequest = vi.fn(async () => new Response(
      JSON.stringify({ id: "task-1", status: "done" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", dispositionRequest);
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
    let dispatchSeen!: () => void;
    const dispatchReceived = new Promise<void>((resolve) => { dispatchSeen = resolve; });
    let acceptanceSeen!: () => void;
    const acceptanceLogged = new Promise<void>((resolve) => { acceptanceSeen = resolve; });
    let completionSent!: () => void;
    const completionDelivered = new Promise<void>((resolve) => { completionSent = resolve; });
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const incoming = JSON.parse(String(raw)) as Record<string, unknown>;
        if (incoming.type === "dispatch") {
          dispatchSeen();
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: incoming.runId, taskId: incoming.taskId, agentId: incoming.agentId, accepted: true, duplicate: false, state: "accepted" }));
        }
        if (incoming.type === "cancel") {
          socket.send(JSON.stringify({ type: "run_result", version: 1, runId: incoming.runId, taskId: incoming.taskId, agentId: incoming.agentId, status: "completed", result: completedEvidence() }));
          socket.once("pong", completionSent);
          socket.ping();
        }
      });
    });
    try {
      vi.useFakeTimers();
      const resultPromise = execute({
        ...context(testGateway.port),
        onLog: async (_stream, line) => {
          if (line === "OpenHands gateway dispatch accepted.\n") acceptanceSeen();
        },
      });
      await dispatchReceived;
      await acceptanceLogged;
      await vi.advanceTimersByTimeAsync(60_000);
      await completionDelivered;
      expect(dispositionRequest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(resultPromise).resolves.toMatchObject({
        errorCode: "OPENHANDS_INDETERMINATE",
        resultJson: { state: "indeterminate", reason: "cancel_unacknowledged" },
      });
    } finally {
      vi.useRealTimers();
      await testGateway.close();
    }
  });

  it("records an unacknowledged cancellation disconnect as indeterminate", async () => {
    await setGatewayToken();
    let dispatchSeen!: () => void;
    const dispatchReceived = new Promise<void>((resolve) => { dispatchSeen = resolve; });
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === "dispatch") {
          dispatchSeen();
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true, duplicate: false, state: "accepted" }));
        }
        if (frame.type === "cancel") {
          const transport = socket as unknown as { _socket: { write: (data: Uint8Array) => boolean } };
          transport._socket.write(Buffer.from([0x81, 0x80, 0x00, 0x00, 0x00, 0x00]));
        }
      });
    });
    try {
      vi.useFakeTimers();
      const resultPromise = execute(context(testGateway.port));
      await dispatchReceived;
      await vi.advanceTimersByTimeAsync(65_000);
      await expect(resultPromise).resolves.toMatchObject({ errorCode: "OPENHANDS_INDETERMINATE", timedOut: false, clearSession: false, resultJson: { state: "indeterminate", reason: "cancel_unacknowledged" } });
    } finally { vi.useRealTimers(); await testGateway.close(); }
  });
});
