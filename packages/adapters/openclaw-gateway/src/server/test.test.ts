import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("OpenClaw gateway environment test", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the protected service token when no agent-specific token is configured", async () => {
    vi.stubEnv("OPENCLAW_TOKEN", "test-service-token");

    const result = await testEnvironment({
      adapterType: "openclaw_gateway",
      config: { url: "ws://127.0.0.1:1" },
    } as never);

    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "openclaw_gateway_auth_present",
      level: "info",
    }));
  });
});
