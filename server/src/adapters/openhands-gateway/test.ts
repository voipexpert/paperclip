import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { WebSocket, type RawData } from "ws";
import { ContractError, parseOpenHandsConfig, readGatewayToken } from "./contract.js";

function failure(code: string): AdapterEnvironmentTestResult {
  return { adapterType: "openhands_gateway", status: "fail", testedAt: new Date().toISOString(), checks: [{ code, level: "error", message: "OpenHands gateway environment check failed." }] };
}

export async function testEnvironment(context: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseOpenHandsConfig(context.config);
  const token = readGatewayToken(process.env);
  if (config instanceof ContractError) return failure("OPENHANDS_ENV_CONFIG");
  if (token instanceof ContractError) return failure("OPENHANDS_ENV_TOKEN");
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(config.url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024, handshakeTimeout: 8_000 });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener("message", onMessage);
        socket.removeListener("error", onError);
        if (socket.readyState !== WebSocket.CLOSED) { try { socket.terminate(); } catch { socket.close(); } }
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("timeout")), 8_000);
      const onMessage = (raw: RawData) => {
        try {
          const received = JSON.parse(String(raw)) as Record<string, unknown>;
          if (Object.keys(received).length !== 2 || received.type !== "hello" || received.version !== 1) throw new Error("protocol");
          finish();
        } catch { finish(new Error("protocol")); }
      };
      const onError = () => finish(new Error("error"));
      socket.once("message", onMessage);
      socket.once("error", onError);
    });
    return { adapterType: "openhands_gateway", status: "pass", testedAt: new Date().toISOString(), checks: [{ code: "OPENHANDS_ENV_OK", level: "info", message: "OpenHands gateway authenticated handshake succeeded." }] };
  } catch { return failure("OPENHANDS_ENV_UNREACHABLE"); }
}
