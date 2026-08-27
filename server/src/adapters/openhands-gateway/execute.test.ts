import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const TOKEN = "a".repeat(64);
const TOKEN_GID = 4242;

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

afterEach(async () => {
  if (originalTokenFile === undefined) delete process.env.OPENHANDS_GATEWAY_TOKEN_FILE;
  else process.env.OPENHANDS_GATEWAY_TOKEN_FILE = originalTokenFile;
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

describe("OpenHands gateway contract", () => {
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

  it("ignores only core-injected runtime skills in the live execution context", async () => {
    await setGatewayToken();
    const base = context(1);
    const runtimeSkills = [{ key: "company/review", runtimeName: "review", source: "managed" }];
    const liveContext = {
      ...base,
      config: { ...base.config, paperclipRuntimeSkills: runtimeSkills },
    };

    expect(parseOpenHandsConfig(liveContext.config)).toBeInstanceOf(Error);
    await expect(execute(liveContext)).resolves.toMatchObject({ errorCode: "OPENHANDS_UNREACHABLE" });

    const unknownContext = {
      ...liveContext,
      config: { ...liveContext.config, operatorUnknown: true },
    };
    await expect(execute(unknownContext)).resolves.toMatchObject({ errorCode: "OPENHANDS_CONFIG" });
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
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"], ["stdout", "OpenHands gateway completed.\n"]]);
    } finally { await testGateway.close(); }
  });

  it("accepts the documented exact lifecycle frames and terminal completed evidence", async () => {
    await setGatewayToken();
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
    } finally { await testGateway.close(); }
  });

  it("accepts the exact Hermes no-change success evidence union", async () => {
    await setGatewayToken();
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const dispatch = JSON.parse(String(raw));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true, duplicate: false, state: "accepted" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: noChangeEvidence() }));
      });
    });
    try { await expect(execute(context(testGateway.port))).resolves.toMatchObject({ exitCode: 0, resultJson: noChangeEvidence() }); }
    finally { await testGateway.close(); }
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
      const resultPromise = execute(context(testGateway.port));
      await dispatchReceived;
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;
      expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "OPENHANDS_TIMEOUT" });
      expect(received.filter((frame) => frame.type === "cancel")).toEqual([{ type: "cancel", version: 1, runId: "run-1", taskId: "task-1", agentId: "agent-oh" }]);
    } finally { vi.useRealTimers(); await testGateway.close(); }
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
