import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenHandsDispositionError, finalizeOpenHandsDisposition } from "./disposition.js";

const noChangeEvidence = {
  version: 1,
  outcome: "no_change",
  repository: "voipexpert/openhands-worker-acceptance",
  base_ref: "main",
  commit: "b".repeat(40),
  tests: [{ name: "pnpm test", status: "passed" }],
  summary: "No change required.",
};

const changedEvidence = {
  version: 1,
  repository: "voipexpert/openhands-worker-acceptance",
  base_ref: "main",
  branch: "openhands/pc-123",
  commit: "a".repeat(40),
  tests: [{ name: "pnpm test", status: "passed" }],
  draft_pr: { number: 1, url: "https://github.com/voipexpert/openhands-worker-acceptance/pull/1" },
  summary: "untrusted worker prose must never appear in Paperclip",
};

type CapturedRequest = { url: string; init: RequestInit };

function successfulResponse(id = "task-1", status = "done"): Response {
  return new Response(JSON.stringify({ id, status }), { status: 200, headers: { "content-type": "application/json" } });
}

function requestThatCaptures(calls: CapturedRequest[], response: Response = successfulResponse()): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
}

function input(overrides: Partial<Parameters<typeof finalizeOpenHandsDisposition>[0]> = {}) {
  return {
    issueId: "task-1",
    evidence: noChangeEvidence,
    authToken: "run-token",
    apiUrl: "http://127.0.0.1:3100",
    ...overrides,
  };
}

async function expectDispositionFailure(action: () => Promise<void>): Promise<OpenHandsDispositionError> {
  try {
    await action();
    throw new Error("expected disposition failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenHandsDispositionError);
    expect(error).toMatchObject({ message: "OpenHands disposition failed." });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    return error as OpenHandsDispositionError;
  }
}

describe("finalizeOpenHandsDisposition", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("patches the normalized issue endpoint with a deterministic no-change disposition", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input(), requestThatCaptures(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3100/api/issues/task-1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer run-token");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      status: "done",
      comment: "OpenHands completed with validated no-change evidence for voipexpert/openhands-worker-acceptance at main commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
    });
  });

  it("uses validated change evidence without copying the worker summary", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input({ evidence: changedEvidence }), requestThatCaptures(calls));

    const body = String(calls[0]?.init.body);
    expect(body).toContain("validated change evidence");
    expect(body).not.toContain(changedEvidence.summary);
  });

  it.each([
    ["missing token", input({ authToken: undefined })],
    ["blank token", input({ authToken: "   " })],
    ["missing API URL", input({ apiUrl: undefined })],
    ["malformed API URL", input({ apiUrl: "not a URL" })],
    ["non-HTTP API URL", input({ apiUrl: "ftp://127.0.0.1:3100" })],
    ["credentialed API URL", input({ apiUrl: "http://user:password@127.0.0.1:3100" })],
    ["API URL with empty userinfo", input({ apiUrl: "http://@127.0.0.1:3100" })],
    ["API URL with a query", input({ apiUrl: "http://127.0.0.1:3100?token=forbidden" })],
    ["API URL with an empty query delimiter", input({ apiUrl: "http://127.0.0.1:3100?" })],
    ["API URL with a fragment", input({ apiUrl: "http://127.0.0.1:3100#forbidden" })],
    ["API URL with an empty fragment delimiter", input({ apiUrl: "http://127.0.0.1:3100#" })],
    ["API URL with an untrusted base path", input({ apiUrl: "http://127.0.0.1:3100/not-api" })],
  ])("rejects %s before sending a request", async (_name, unsafeInput) => {
    const calls: CapturedRequest[] = [];

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(unsafeInput, requestThatCaptures(calls)));

    expect(calls).toHaveLength(0);
  });

  it.each([
    ["repository", { ...noChangeEvidence, repository: "untrusted worker prose" }],
    ["base ref", { ...noChangeEvidence, base_ref: "untrusted worker prose" }],
  ])("rejects prose-shaped %s before interpolating it into a comment", async (_name, evidence) => {
    const calls: CapturedRequest[] = [];

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(input({ evidence }), requestThatCaptures(calls)));

    expect(calls).toHaveLength(0);
  });

  it("uses an API base ending in /api and percent-encodes the issue ID", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input({ issueId: "task / one", apiUrl: "https://paperclip.example/internal/api" }), requestThatCaptures(calls, successfulResponse("task / one")));

    expect(calls[0]?.url).toBe("https://paperclip.example/internal/api/issues/task%20%2F%20one");
  });

  it.each([
    ["a redirect", (() => {
      const response = successfulResponse();
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    })()],
    ["a non-success response", new Response("not allowed", { status: 500 })],
    ["invalid UTF-8", new Response(new Uint8Array([0xc3, 0x28]), { status: 200 })],
    ["malformed JSON", new Response("{", { status: 200 })],
    ["a mismatched issue ID", successfulResponse("other-issue")],
    ["a non-done status", successfulResponse("task-1", "in_progress")],
  ])("rejects %s without exposing response details", async (_name, response) => {
    await expectDispositionFailure(() => finalizeOpenHandsDisposition(input(), requestThatCaptures([], response)));
  });

  it("cancels an incrementally streamed response once it exceeds 65,536 bytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    });

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(input(), requestThatCaptures([], new Response(stream, { status: 200 }))));

    expect(cancelled).toBe(true);
  });

  it("aborts a request that exceeds the ten-second deadline", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const request = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("request timed out", "AbortError"));
      }, { once: true });
    })) as typeof fetch;

    const pending = expectDispositionFailure(() => finalizeOpenHandsDisposition(input(), request));
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(aborted).toBe(true);
  });

  it("accepts an idempotent response for the matching issue already in done", async () => {
    await expect(finalizeOpenHandsDisposition(input(), requestThatCaptures([], successfulResponse("task-1", "done")))).resolves.toBeUndefined();
  });
});
