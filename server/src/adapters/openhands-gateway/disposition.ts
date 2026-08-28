import {
  openHandsDispositionEvidenceSchema,
  type OpenHandsDispositionEvidence,
} from "./disposition-contract.js";

export const RESPONSE_LIMIT = 65_536;
export const REQUEST_TIMEOUT_MS = 10_000;

const FAILURE_MESSAGE = "OpenHands disposition failed.";

export class OpenHandsDispositionError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = "OpenHandsDispositionError";
  }
}

type DispositionInput = {
  issueId: string;
  evidence: Record<string, unknown>;
  authToken: string | undefined;
  apiUrl: string | undefined;
};

function failure(): OpenHandsDispositionError {
  return new OpenHandsDispositionError();
}

function validCommentField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.normalize("NFC") === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !hasLoneSurrogate(value);
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

function dispositionEvidence(evidence: Record<string, unknown>): OpenHandsDispositionEvidence {
  const parsed = openHandsDispositionEvidenceSchema.safeParse({
    outcome: evidence.outcome === "no_change" ? "no_change" : evidence.outcome === undefined ? "change" : evidence.outcome,
    repository: evidence.repository,
    baseRef: evidence.base_ref,
    commit: evidence.commit,
  });
  if (!parsed.success) throw failure();
  return parsed.data;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function issueEndpoint(apiUrl: string, issueId: string): string {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(apiUrl)?.[1];
  if (apiUrl.includes("?") || apiUrl.includes("#") || authority?.includes("@")) throw failure();
  const base = new URL(apiUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) throw failure();
  if (base.protocol === "http:" && !isLoopbackHostname(base.hostname)) throw failure();
  if (base.pathname !== "/" && !base.pathname.endsWith("/api")) throw failure();
  const path = base.pathname === "/" ? "/api" : base.pathname;
  base.pathname = `${path}/issues/${encodeURIComponent(issueId)}/openhands-disposition`;
  return base.toString();
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel();
        throw failure();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function confirmsDone(value: unknown, issueId: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).id === issueId && (value as Record<string, unknown>).status === "done";
}

export async function finalizeOpenHandsDisposition(
  input: DispositionInput,
  request: typeof fetch = globalThis.fetch,
): Promise<void> {
  try {
    if (!input.authToken || input.authToken.trim().length === 0 || !input.apiUrl || !validCommentField(input.issueId)) throw failure();
    const endpoint = issueEndpoint(input.apiUrl, input.issueId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(dispositionEvidence(input.evidence)),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected || !response.ok) throw failure();
      const parsed = JSON.parse(await readBoundedBody(response));
      if (!confirmsDone(parsed, input.issueId)) throw failure();
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    throw failure();
  }
}
