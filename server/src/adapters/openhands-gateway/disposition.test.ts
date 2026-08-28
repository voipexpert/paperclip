import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

async function localHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

  it("posts only bounded evidence to the dedicated disposition endpoint", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input(), requestThatCaptures(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3100/api/issues/task-1/openhands-disposition");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer run-token");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      outcome: "no_change",
      repository: "voipexpert/openhands-worker-acceptance",
      baseRef: "main",
      commit: "b".repeat(40),
    });
  });

  it("uses validated change evidence without copying the worker summary", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input({ evidence: changedEvidence }), requestThatCaptures(calls));

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      outcome: "change",
      repository: changedEvidence.repository,
      baseRef: changedEvidence.base_ref,
      commit: changedEvidence.commit,
    });
    expect(JSON.stringify(body)).not.toContain(changedEvidence.summary);
  });

  it("accepts validated Git-ref punctuation shared with the dispatch contract", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(
      input({ evidence: { ...noChangeEvidence, base_ref: "release/v1+meta" } }),
      requestThatCaptures(calls),
    );

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ baseRef: "release/v1+meta" });
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
    ["control-containing base ref", { ...noChangeEvidence, base_ref: "release/v1\nmain" }],
  ])("rejects prose-shaped %s before interpolating it into a comment", async (_name, evidence) => {
    const calls: CapturedRequest[] = [];

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(input({ evidence }), requestThatCaptures(calls)));

    expect(calls).toHaveLength(0);
  });

  it("uses an API base ending in /api and percent-encodes the issue ID", async () => {
    const calls: CapturedRequest[] = [];

    await finalizeOpenHandsDisposition(input({ issueId: "task / one", apiUrl: "https://paperclip.example/internal/api" }), requestThatCaptures(calls, successfulResponse("task / one")));

    expect(calls[0]?.url).toBe("https://paperclip.example/internal/api/issues/task%20%2F%20one/openhands-disposition");
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

  it("rejects a redirect through native fetch without following it", async () => {
    const paths: string[] = [];
    const server = await localHttpServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(302, { location: "/should-not-be-followed" });
      response.end();
    });
    try {
      await expectDispositionFailure(() => finalizeOpenHandsDisposition(input({ apiUrl: server.url })));
      expect(paths).toEqual(["/api/issues/task-1/openhands-disposition"]);
    } finally {
      await server.close();
    }
  });

  it("aborts native fetch when response headers arrive but the body stalls", async () => {
    let headersSeen!: () => void;
    const responseHeadersSent = new Promise<void>((resolve) => { headersSeen = resolve; });
    const stalledResponse: { current: ServerResponse | null } = { current: null };
    const server = await localHttpServer((_request, response) => {
      stalledResponse.current = response;
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"id":"task-1"');
      headersSeen();
    });
    try {
      vi.useFakeTimers();
      const pending = expectDispositionFailure(() => finalizeOpenHandsDisposition(input({ apiUrl: server.url })));
      await responseHeadersSent;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      stalledResponse.current?.destroy();
      await server.close();
    }
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

  it("accepts a success body at exactly 65,536 bytes", async () => {
    const prefix = '{"id":"task-1","status":"done","padding":"';
    const suffix = '"}';
    const body = `${prefix}${"x".repeat(65_536 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(body, "utf8")).toBe(65_536);

    await expect(finalizeOpenHandsDisposition(
      input(),
      requestThatCaptures([], new Response(body, { status: 200 })),
    )).resolves.toBeUndefined();
  });

  it("rejects a response body at exactly 65,537 bytes", async () => {
    const prefix = '{"id":"task-1","status":"done","padding":"';
    const suffix = '"}';
    const body = `${prefix}${"x".repeat(65_537 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(body, "utf8")).toBe(65_537);

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(
      input(),
      requestThatCaptures([], new Response(body, { status: 200 })),
    ));
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
    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after both immediate success and failure", async () => {
    vi.useFakeTimers();

    await finalizeOpenHandsDisposition(input(), requestThatCaptures([], successfulResponse()));
    expect(vi.getTimerCount()).toBe(0);

    await expectDispositionFailure(() => finalizeOpenHandsDisposition(
      input(),
      requestThatCaptures([], new Response("rejected", { status: 409 })),
    ));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an idempotent response for the matching issue already in done", async () => {
    await expect(finalizeOpenHandsDisposition(input(), requestThatCaptures([], successfulResponse("task-1", "done")))).resolves.toBeUndefined();
  });
});
