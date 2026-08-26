import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { execute } from "./execute.js";

const tokenDirectories: string[] = [];
const originalTokenFile = process.env.OPENHANDS_GATEWAY_TOKEN_FILE;

afterEach(async () => {
  if (originalTokenFile === undefined) delete process.env.OPENHANDS_GATEWAY_TOKEN_FILE;
  else process.env.OPENHANDS_GATEWAY_TOKEN_FILE = originalTokenFile;
  await Promise.all(tokenDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setGatewayToken(value = "test-token", mode = 0o600): Promise<void> {
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
  it("reads only a mode-0600 token file and builds dispatch exclusively from mapped project fields", async () => {
    await setGatewayToken();
    const token = readGatewayToken(process.env);
    assert.equal(token, "test-token");

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
    expect(readGatewayToken(process.env)).toBeInstanceOf(Error);

    const validConfig = {
      url: "wss://gateway.example/paperclip-worker/v1", timeoutSec: 60,
      projectTargets: { project: { repository: "owner/repo", baseRef: "main", profile: "openhands" } },
    };
    for (const config of [
      { ...validConfig, authToken: "forbidden" },
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
      assert.equal(request.headers.authorization, "Bearer test-token");
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(frame);
        if (frame.type !== "dispatch") return;
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true }));
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: "other", taskId: frame.taskId, agentId: frame.agentId, status: "completed", result: { forged: true } }));
        socket.send(JSON.stringify({ type: "run_event", version: 1, runId: frame.runId, taskId: "other", agentId: frame.agentId, event: "progress" }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: "other", status: "completed", result: { forged: true } }));
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, status: "completed", result: { outcome: "canary complete" } }));
      });
    });
    try {
      const result = await execute({ ...context(testGateway.port), onLog: async (stream, line) => { logs.push([stream, line]); } });
      expect(received).toEqual([{
        type: "dispatch", version: 1, runId: "run-1", taskId: "task-1", agentId: "agent-oh", projectId: "project-acceptance",
        repository: "voipexpert/openhands-worker-acceptance", baseRef: "main", profile: "openhands",
        title: "Canary", objective: "Make the bounded canary change.",
      }]);
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, resultJson: { outcome: "canary complete" } });
      expect(logs).toEqual([["stdout", "OpenHands gateway dispatch accepted.\n"], ["stdout", "OpenHands gateway completed.\n"]]);
    } finally { await testGateway.close(); }
  });

  it("returns bounded fixed errors for rejected, malformed, and non-completed terminal results without leaking gateway data", async () => {
    await setGatewayToken();
    for (const response of [
      { type: "dispatch_ack", accepted: false, error: "do not leak this exception body" },
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
        socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: {} }));
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
        socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true }));
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
      { name: "ack", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, accepted: true, extra: true })) },
      { name: "event", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "run_event", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, event: "progress", extra: true })) },
      { name: "result", onConnect: (socket, dispatch) => socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch?.runId, taskId: dispatch?.taskId, agentId: dispatch?.agentId, status: "completed", result: { summary: "x".repeat(4_097) } })) },
    ];
    for (const testCase of cases) {
      const testGateway = await gateway((socket) => {
        if (testCase.name === "hello") { testCase.onConnect(socket); return; }
        socket.send(JSON.stringify({ type: "hello", version: 1 }));
        socket.on("message", (raw) => {
          const dispatch = JSON.parse(String(raw));
          if (testCase.name !== "ack") socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, accepted: true }));
          testCase.onConnect(socket, dispatch);
          if (testCase.name === "ack" || testCase.name === "event") socket.send(JSON.stringify({ type: "run_result", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId, status: "completed", result: { summary: "valid" } }));
        });
      });
      try {
        await expect(execute(context(testGateway.port))).resolves.toMatchObject({ errorCode: "OPENHANDS_PROTOCOL" });
      } finally { await testGateway.close(); }
    }
  });

  it("sends one matching cancel at its absolute deadline and returns OPENHANDS_TIMEOUT after acknowledgement wait", async () => {
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
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true }));
        }
        if (frame.type === "cancel") socket.send(JSON.stringify({ type: "run_result", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, status: "cancelled", result: { state: "cancelled" } }));
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

  it("keeps OPENHANDS_TIMEOUT when the socket errors during cancellation grace", async () => {
    await setGatewayToken();
    let dispatchSeen!: () => void;
    const dispatchReceived = new Promise<void>((resolve) => { dispatchSeen = resolve; });
    const testGateway = await gateway((socket) => {
      socket.send(JSON.stringify({ type: "hello", version: 1 }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === "dispatch") {
          dispatchSeen();
          socket.send(JSON.stringify({ type: "dispatch_ack", version: 1, runId: frame.runId, taskId: frame.taskId, agentId: frame.agentId, accepted: true }));
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
      await expect(resultPromise).resolves.toMatchObject({ errorCode: "OPENHANDS_TIMEOUT", timedOut: true });
    } finally { vi.useRealTimers(); await testGateway.close(); }
  });
});
