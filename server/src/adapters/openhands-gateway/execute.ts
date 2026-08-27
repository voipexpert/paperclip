import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { ContractError, buildDispatch, parseOpenHandsConfig, parsePaperclipIssue, readGatewayToken } from "./contract.js";

const MAX_PAYLOAD = 64 * 1024;
const CANCEL_ACK_WAIT_MS = 5_000;
const MAX_FRAME_STRING_BYTES = 128;
const MAX_RESULT_STRING_BYTES = 4_096;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_KEYS = 32;
const MAX_RESULT_ARRAY_ITEMS = 32;
const MAX_RESULT_DEPTH = 4;
const NONTERMINAL_STATES = new Set(["accepted", "preparing", "running", "testing", "draft_pr_created"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "indeterminate"]);
const FAILURE_CODES = new Set(["validation", "busy", "canvas_unavailable", "model_provider_failure", "timeout", "broker_rejection", "policy_rejection", "indeterminate", "evidence_rejection", "workspace_rejection", "protocol_rejection", "cancelled_by_request"]);
const fixedMessages: Record<string, string> = {
  OPENHANDS_CONFIG: "OpenHands gateway configuration is invalid.",
  OPENHANDS_TOKEN: "OpenHands gateway credential is unavailable.",
  OPENHANDS_ISSUE: "OpenHands gateway heartbeat has no actionable assigned issue.",
  OPENHANDS_ASSIGNMENT: "OpenHands gateway issue assignment is invalid.",
  OPENHANDS_PROJECT: "OpenHands gateway project target is unavailable.",
  OPENHANDS_UNREACHABLE: "OpenHands gateway is unavailable.",
  OPENHANDS_PROTOCOL: "OpenHands gateway protocol validation failed.",
  OPENHANDS_REJECTED: "OpenHands gateway rejected the dispatch.",
  OPENHANDS_DISCONNECTED: "OpenHands gateway disconnected before completion.",
  OPENHANDS_INDETERMINATE: "OpenHands gateway disconnected after dispatch acceptance.",
  OPENHANDS_FAILED: "OpenHands gateway reported failure.",
  OPENHANDS_CANCELLED: "OpenHands gateway reported cancellation.",
  OPENHANDS_TIMEOUT: "OpenHands gateway timed out.",
  OPENHANDS_PRE_DISPATCH_TIMEOUT: "OpenHands gateway timed out before dispatch.",
  OPENHANDS_BUSY: "OpenHands gateway is busy.",
};

function result(code: string, timedOut = false): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut, errorCode: code, errorMessage: fixedMessages[code] };
}

function frame(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedFrameString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_FRAME_STRING_BYTES
    && value.normalize("NFC") === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !hasLoneSurrogate(value);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function isBoundedResultValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_RESULT_STRING_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_RESULT_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= MAX_RESULT_ARRAY_ITEMS && value.every((item) => isBoundedResultValue(item, depth + 1));
  const object = frame(value);
  if (!object || Object.keys(object).length > MAX_RESULT_KEYS) return false;
  return Object.entries(object).every(([key, item]) => boundedFrameString(key) && isBoundedResultValue(item, depth + 1));
}

function boundedText(value: unknown, byteLimit: number, characterLimit?: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= byteLimit
    && (characterLimit === undefined || Array.from(value).length <= characterLimit)
    && value.normalize("NFC") === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !hasLoneSurrogate(value);
}

function evidenceText(value: unknown, byteLimit: number, characterLimit?: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= byteLimit
    && (characterLimit === undefined || Array.from(value).length <= characterLimit)
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !hasLoneSurrogate(value);
}

function isUtcTimestamp(value: unknown): boolean {
  if (!boundedText(value, 64) || !value.endsWith("Z")) return false;
  return Number.isFinite(Date.parse(value));
}

function isCompletedEvidence(value: unknown, dispatch: { repository: string; baseRef: string; taskId: string; runId: string }): value is Record<string, unknown> {
  const evidence = frame(value);
  const noChange = !!evidence && hasExactKeys(evidence, ["version", "outcome", "repository", "base_ref", "commit", "tests", "summary"]);
  if (!evidence || (!noChange && !hasExactKeys(evidence, ["version", "repository", "base_ref", "branch", "commit", "tests", "draft_pr", "summary"]))
    || evidence.version !== 1 || evidence.repository !== dispatch.repository || evidence.base_ref !== dispatch.baseRef
    || !/^[0-9a-f]{40}$/.test(String(evidence.commit))
    || !evidenceText(evidence.summary, 2_000)) return false;
  if (noChange) {
    if (evidence.outcome !== "no_change") return false;
  } else {
    const digest = createHash("sha256").update(`${dispatch.taskId}\0${dispatch.runId}`, "utf8").digest("hex").slice(0, 20);
    if (evidence.branch !== `openhands/pc-${digest}`) return false;
    const draft = frame(evidence.draft_pr);
    if (!draft || !hasExactKeys(draft, ["number", "url"]) || !Number.isInteger(draft.number) || Number(draft.number) < 1
      || draft.url !== `https://github.com/${dispatch.repository}/pull/${draft.number}`) return false;
  }
  if (!Array.isArray(evidence.tests) || evidence.tests.length > MAX_RESULT_ARRAY_ITEMS) return false;
  if (!evidence.tests.every((test) => {
    const item = frame(test);
    return !!item && hasExactKeys(item, ["name", "status"]) && evidenceText(item.name, Number.MAX_SAFE_INTEGER, 200)
      && (item.status === "passed" || item.status === "failed" || item.status === "unknown");
  })) return false;
  try { return isBoundedResultValue(evidence) && Buffer.byteLength(JSON.stringify(evidence), "utf8") <= MAX_RESULT_BYTES; } catch { return false; }
}

function isFailureEvidence(value: unknown): value is Record<string, unknown> {
  const evidence = frame(value);
  return !!evidence && hasExactKeys(evidence, ["code"]) && typeof evidence.code === "string" && FAILURE_CODES.has(evidence.code);
}

function isHello(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ["type", "version"]) && value.type === "hello" && value.version === 1;
}

function isDispatchAck(value: Record<string, unknown>): boolean {
  const shared = value.type === "dispatch_ack" && value.version === 1 && boundedFrameString(value.runId)
    && boundedFrameString(value.taskId) && boundedFrameString(value.agentId);
  if (!shared) return false;
  if (value.accepted === true) {
    return hasExactKeys(value, ["type", "version", "runId", "taskId", "agentId", "accepted", "duplicate", "state"])
      && typeof value.duplicate === "boolean" && typeof value.state === "string"
      && (NONTERMINAL_STATES.has(value.state) || TERMINAL_STATES.has(value.state));
  }
  return value.accepted === false && hasExactKeys(value, ["type", "version", "runId", "taskId", "agentId", "accepted", "reason"])
    && (value.reason === "busy" || value.reason === "validation");
}

function isRunEvent(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ["type", "version", "runId", "taskId", "agentId", "state", "timestamp"])
    && value.type === "run_event" && value.version === 1 && boundedFrameString(value.runId)
    && boundedFrameString(value.taskId) && boundedFrameString(value.agentId) && typeof value.state === "string"
    && NONTERMINAL_STATES.has(value.state) && isUtcTimestamp(value.timestamp);
}

function isRunResult(value: Record<string, unknown>, dispatch: { repository: string; baseRef: string; taskId: string; runId: string }): boolean {
  return hasExactKeys(value, ["type", "version", "runId", "taskId", "agentId", "status", "result"])
    && value.type === "run_result" && value.version === 1 && boundedFrameString(value.runId)
    && boundedFrameString(value.taskId) && boundedFrameString(value.agentId)
    && typeof value.status === "string" && TERMINAL_STATES.has(value.status)
    && (value.status === "completed" ? isCompletedEvidence(value.result, dispatch) : isFailureEvidence(value.result));
}

function matches(frameValue: Record<string, unknown>, dispatch: { runId: string; taskId: string; agentId: string }): boolean {
  return frameValue.version === 1 && frameValue.runId === dispatch.runId && frameValue.taskId === dispatch.taskId && frameValue.agentId === dispatch.agentId;
}

function canonicalFrame(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFrame).join(",")}]`;
  const object = frame(value);
  if (!object) return JSON.stringify(value);
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalFrame(object[key])}`).join(",")}}`;
}

export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseOpenHandsConfig(context);
  if (config instanceof ContractError) return result(config.code);
  const token = readGatewayToken(process.env);
  if (token instanceof ContractError) return result(token.code);
  const issue = parsePaperclipIssue(context);
  if (issue instanceof ContractError) return result(issue.code);
  if (issue.assigneeAgentId !== context.agent.id) return result("OPENHANDS_ASSIGNMENT");
  let dispatch;
  try { dispatch = buildDispatch(context, config, issue); } catch (error) { return result(error instanceof ContractError ? error.code : "OPENHANDS_ISSUE"); }
  let socket: WebSocket;
  try { socket = new WebSocket(config.url, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_PAYLOAD }); }
  catch { return result("OPENHANDS_UNREACHABLE"); }

  return new Promise((resolve) => {
    let settled = false;
    let dispatched = false;
    let dispatchSent = false;
    let acknowledged = false;
    let acknowledgement: string | null = null;
    let cancellationStarted = false;
    let cancelWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: AdapterExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (cancelWaitTimer) clearTimeout(cancelWaitTimer);
      if (socket.readyState !== WebSocket.CLOSED) { try { socket.terminate(); } catch { socket.close(); } }
      resolve(value);
    };
    const indeterminate = (reason = "post_dispatch_disconnect") => finish({
      ...result("OPENHANDS_INDETERMINATE"),
      clearSession: false,
      resultJson: { state: "indeterminate", reason },
    });
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      if (!dispatchSent) { finish(result("OPENHANDS_PRE_DISPATCH_TIMEOUT", true)); return; }
      cancellationStarted = true;
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "cancel", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId })); } catch { /* fixed timeout result below */ }
      }
      cancelWaitTimer = setTimeout(() => indeterminate("cancel_unacknowledged"), CANCEL_ACK_WAIT_MS);
    }, config.timeoutMs);

    socket.on("error", () => {
      if (cancellationStarted) return;
      dispatchSent ? indeterminate() : finish(result("OPENHANDS_UNREACHABLE"));
    });
    socket.on("close", () => {
      if (!settled && !cancellationStarted) dispatchSent ? indeterminate() : finish(result("OPENHANDS_DISCONNECTED"));
    });
    socket.on("message", async (raw) => {
      let incoming: Record<string, unknown> | null;
      try { incoming = frame(JSON.parse(String(raw))); } catch { incoming = null; }
      if (!incoming) { finish(result("OPENHANDS_PROTOCOL")); return; }
      if (incoming.type === "hello") {
        if (!isHello(incoming)) { finish(result("OPENHANDS_PROTOCOL")); return; }
        if (dispatched) return;
        dispatched = true;
        try {
          socket.send(JSON.stringify(dispatch));
          dispatchSent = true;
        } catch { finish(result("OPENHANDS_UNREACHABLE")); }
        return;
      }
      if (incoming.type === "dispatch_ack") {
        if (!isDispatchAck(incoming)) { finish(result("OPENHANDS_PROTOCOL")); return; }
        if (!matches(incoming, dispatch)) return;
        const signature = canonicalFrame(incoming);
        if (acknowledged) {
          if (signature !== acknowledgement) finish({ ...result("OPENHANDS_PROTOCOL"), clearSession: false, resultJson: { state: "indeterminate", reason: "ack_contradiction" } });
          return;
        }
        if (incoming.accepted === false) { await context.onLog("stderr", "OpenHands gateway dispatch rejected.\n"); finish(result(incoming.reason === "busy" ? "OPENHANDS_BUSY" : "OPENHANDS_REJECTED")); return; }
        acknowledged = true;
        acknowledgement = signature;
        await context.onLog("stdout", "OpenHands gateway dispatch accepted.\n");
        return;
      }
      if (incoming.type === "run_event") {
        if (!isRunEvent(incoming)) { finish(result("OPENHANDS_PROTOCOL")); return; }
        if (!matches(incoming, dispatch)) return;
        if (!acknowledged) finish(result("OPENHANDS_PROTOCOL"));
        return;
      }
      if (incoming.type !== "run_result" || !isRunResult(incoming, dispatch)) {
        finish(result("OPENHANDS_PROTOCOL"));
        return;
      }
      if (!matches(incoming, dispatch)) return;
      if (!acknowledged) { finish(result("OPENHANDS_PROTOCOL")); return; }
      if (incoming.status === "completed") {
        await context.onLog("stdout", "OpenHands gateway completed.\n");
        finish({ exitCode: 0, signal: null, timedOut: false, resultJson: frame(incoming.result)! });
      } else {
        if (incoming.status === "indeterminate") { indeterminate("gateway_indeterminate"); return; }
        const code = incoming.status === "failed" ? "OPENHANDS_FAILED" : incoming.status === "cancelled" ? "OPENHANDS_CANCELLED" : "OPENHANDS_TIMEOUT";
        await context.onLog("stderr", `OpenHands gateway ${incoming.status}.\n`);
        finish({ ...result(code, incoming.status === "timed_out"), resultJson: { state: incoming.status, reason: (incoming.result as { code: string }).code } });
      }
    });
  });
}
