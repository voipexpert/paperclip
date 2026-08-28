import { z } from "zod";

export const OPENHANDS_DISPOSITION_AUTHORIZATION_REASON = "openhands_transactional_disposition";
export const OPENHANDS_DISPOSITION_REJECTION = "OpenHands disposition rejected.";

const MAX_IDENTIFIER_BYTES = 128;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (
        index + 1 >= value.length
        || value.charCodeAt(index + 1) < 0xdc00
        || value.charCodeAt(index + 1) > 0xdfff
      ) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isBoundedSafeText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES
    && value.normalize("NFC") === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && !hasLoneSurrogate(value);
}

export function isOpenHandsRepository(value: unknown): value is string {
  return isBoundedSafeText(value)
    && /^[A-Za-z0-9][A-Za-z0-9.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
}

export function isOpenHandsBaseRef(value: unknown): value is string {
  return isBoundedSafeText(value)
    && /^(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/+\-]*$/.test(value)
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".");
}

const repositorySchema = z.string().refine(isOpenHandsRepository);
const baseRefSchema = z.string().refine(isOpenHandsBaseRef);

export const openHandsDispositionEvidenceSchema = z.object({
  outcome: z.enum(["change", "no_change"]),
  repository: repositorySchema,
  baseRef: baseRefSchema,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

export type OpenHandsDispositionEvidence = z.infer<typeof openHandsDispositionEvidenceSchema>;

export function buildOpenHandsDispositionComment(evidence: OpenHandsDispositionEvidence): string {
  const kind = evidence.outcome === "no_change" ? "no-change" : "change";
  return `OpenHands completed with validated ${kind} evidence for ${evidence.repository} at ${evidence.baseRef} commit ${evidence.commit}.`;
}
