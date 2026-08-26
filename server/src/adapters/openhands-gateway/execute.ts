import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { WebSocket } from "ws";
import { ContractError, buildDispatch, parseOpenHandsConfig, parsePaperclipIssue, readGatewayToken } from "./contract.js";

const MAX_PAYLOAD = 64 * 1024;
const CANCEL_ACK_WAIT_MS = 5_000;
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
  OPENHANDS_FAILED: "OpenHands gateway reported failure.",
  OPENHANDS_CANCELLED: "OpenHands gateway reported cancellation.",
  OPENHANDS_TIMEOUT: "OpenHands gateway timed out.",
};

function result(code: string, timedOut = false): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut, errorCode: code, errorMessage: fixedMessages[code] };
}

function frame(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function matches(frameValue: Record<string, unknown>, dispatch: { runId: string; taskId: string; agentId: string }): boolean {
  return frameValue.version === 1 && frameValue.runId === dispatch.runId && frameValue.taskId === dispatch.taskId && frameValue.agentId === dispatch.agentId;
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
    let acknowledged = false;
    let cancellationStarted = false;
    let cancelWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: AdapterExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (cancelWaitTimer) clearTimeout(cancelWaitTimer);
      socket.close();
      resolve(value);
    };
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      cancellationStarted = true;
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "cancel", version: 1, runId: dispatch.runId, taskId: dispatch.taskId, agentId: dispatch.agentId })); } catch { /* fixed timeout result below */ }
      }
      cancelWaitTimer = setTimeout(() => finish(result("OPENHANDS_TIMEOUT", true)), CANCEL_ACK_WAIT_MS);
    }, config.timeoutMs);

    socket.on("error", () => finish(result("OPENHANDS_UNREACHABLE")));
    socket.on("close", () => {
      if (!settled && !cancellationStarted) finish(result("OPENHANDS_DISCONNECTED"));
    });
    socket.on("message", async (raw) => {
      let incoming: Record<string, unknown> | null;
      try { incoming = frame(JSON.parse(String(raw))); } catch { incoming = null; }
      if (!incoming) { finish(result("OPENHANDS_PROTOCOL")); return; }
      if (incoming.type === "hello") {
        if (incoming.version !== 1) { finish(result("OPENHANDS_PROTOCOL")); return; }
        if (dispatched) return;
        dispatched = true;
        try { socket.send(JSON.stringify(dispatch)); } catch { finish(result("OPENHANDS_UNREACHABLE")); }
        return;
      }
      if (!matches(incoming, dispatch)) return;
      if (incoming.type === "dispatch_ack") {
        if (incoming.accepted !== true && incoming.accepted !== false) { finish(result("OPENHANDS_PROTOCOL")); return; }
        if (incoming.accepted === false) { await context.onLog("stderr", "OpenHands gateway dispatch rejected.\n"); finish(result("OPENHANDS_REJECTED")); return; }
        if (!acknowledged) { acknowledged = true; await context.onLog("stdout", "OpenHands gateway dispatch accepted.\n"); }
        return;
      }
      if (incoming.type === "run_event") {
        if (!acknowledged) finish(result("OPENHANDS_PROTOCOL"));
        return;
      }
      if (incoming.type !== "run_result" || !["completed", "failed", "cancelled"].includes(String(incoming.status)) || !frame(incoming.result)) {
        finish(result("OPENHANDS_PROTOCOL"));
        return;
      }
      if (!acknowledged) { finish(result("OPENHANDS_PROTOCOL")); return; }
      if (cancellationStarted) { finish(result("OPENHANDS_TIMEOUT", true)); return; }
      if (incoming.status === "completed") {
        await context.onLog("stdout", "OpenHands gateway completed.\n");
        finish({ exitCode: 0, signal: null, timedOut: false, resultJson: frame(incoming.result) });
      } else {
        const code = incoming.status === "failed" ? "OPENHANDS_FAILED" : "OPENHANDS_CANCELLED";
        await context.onLog("stderr", `OpenHands gateway ${incoming.status}.\n`);
        finish(result(code));
      }
    });
  });
}
