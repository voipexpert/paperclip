import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { WebSocket } from "ws";
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
      const timer = setTimeout(() => reject(new Error("timeout")), 8_000);
      socket.once("message", (raw) => {
        try {
          const received = JSON.parse(String(raw)) as Record<string, unknown>;
          if (received.type !== "hello" || received.version !== 1) throw new Error("protocol");
          clearTimeout(timer); socket.close(); resolve();
        } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
      });
      socket.once("error", reject);
    });
    return { adapterType: "openhands_gateway", status: "pass", testedAt: new Date().toISOString(), checks: [{ code: "OPENHANDS_ENV_OK", level: "info", message: "OpenHands gateway authenticated handshake succeeded." }] };
  } catch { return failure("OPENHANDS_ENV_UNREACHABLE"); }
}
