import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export type Target = { repository: string; baseRef: string; profile: "openhands" };
export type OpenHandsConfig = {
  url: string;
  timeoutMs: number;
  projectTargets: Readonly<Record<string, Target>>;
};
export type PaperclipIssue = {
  id: string;
  status: "todo" | "in_progress";
  assigneeAgentId: string;
  projectId: string;
  title: string;
  description: string;
};
export type DispatchV1 = {
  type: "dispatch";
  version: 1;
  runId: string;
  taskId: string;
  agentId: string;
  projectId: string;
  repository: string;
  baseRef: string;
  profile: "openhands";
  title: string;
  objective: string;
};

export class ContractError extends Error {
  constructor(readonly code: string) {
    super("OpenHands gateway contract validation failed.");
    this.name = "ContractError";
  }
}

const MAX_IDENTIFIER_BYTES = 128;
const MAX_TITLE_CHARACTERS = 300;
const MAX_OBJECTIVE_BYTES = 20_000;
const MAX_TOKEN_BYTES = 4_096;
const MAX_URL_BYTES = 2_048;
const MIN_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 7_200;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedIdentifier(value: unknown): value is string {
  return safeText(value, MAX_IDENTIFIER_BYTES);
}

function safeText(value: unknown, byteLimit: number, characterLimit?: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= byteLimit
    && (characterLimit === undefined || Array.from(value).length <= characterLimit)
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

function keyComponent(value: unknown): value is string {
  return boundedIdentifier(value) && !value.includes(":");
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "127.0.0.1";
}

function configSource(value: AdapterExecutionContext | Record<string, unknown>): Record<string, unknown> | null {
  const input = record(value);
  if (!input) return null;
  return "config" in input ? record(input.config) : input;
}

export function parseOpenHandsConfig(value: AdapterExecutionContext | Record<string, unknown>): OpenHandsConfig | ContractError {
  const input = configSource(value);
  if (!input || !hasOnlyKeys(input, ["url", "timeoutSec", "projectTargets"])) return new ContractError("OPENHANDS_CONFIG");
  if (typeof input.url !== "string" || Buffer.byteLength(input.url, "utf8") > MAX_URL_BYTES || typeof input.timeoutSec !== "number" || !Number.isFinite(input.timeoutSec)) {
    return new ContractError("OPENHANDS_CONFIG");
  }
  let url: URL;
  try { url = new URL(input.url); } catch { return new ContractError("OPENHANDS_CONFIG"); }
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname))) || url.username || url.password || url.hash) {
    return new ContractError("OPENHANDS_CONFIG");
  }
  const rawTargets = record(input.projectTargets);
  if (!rawTargets || Object.keys(rawTargets).length === 0 || Object.keys(rawTargets).length > 32) return new ContractError("OPENHANDS_CONFIG");
  const projectTargets: Record<string, Target> = {};
  for (const [projectId, rawTarget] of Object.entries(rawTargets)) {
    const target = record(rawTarget);
    if (!boundedIdentifier(projectId) || !target || !hasOnlyKeys(target, ["repository", "baseRef", "profile"])
      || !boundedIdentifier(target.repository) || !boundedIdentifier(target.baseRef) || target.profile !== "openhands") {
      return new ContractError("OPENHANDS_CONFIG");
    }
    projectTargets[projectId] = { repository: target.repository, baseRef: target.baseRef, profile: "openhands" };
  }
  return {
    url: url.toString(),
    timeoutMs: Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, input.timeoutSec)) * 1_000,
    projectTargets,
  };
}

export function readGatewayToken(env: NodeJS.ProcessEnv): string | ContractError {
  const tokenFile = env.OPENHANDS_GATEWAY_TOKEN_FILE;
  if (!tokenFile) return new ContractError("OPENHANDS_TOKEN");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size === 0 || stat.size > MAX_TOKEN_BYTES) {
      return new ContractError("OPENHANDS_TOKEN");
    }
    const token = readFileSync(descriptor, "utf8");
    return token.length > 0 && Buffer.byteLength(token, "utf8") <= MAX_TOKEN_BYTES
      && !/[\r\n]/.test(token) && !/^\s|\s$/u.test(token)
      ? token
      : new ContractError("OPENHANDS_TOKEN");
  } catch {
    return new ContractError("OPENHANDS_TOKEN");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function parsePaperclipIssue(value: AdapterExecutionContext | Record<string, unknown>): PaperclipIssue | ContractError {
  const input = record(value);
  const context = input && "context" in input ? record(input.context) : input;
  const issue = context ? record(context.paperclipIssue) : null;
  if (!issue || !keyComponent(issue.id) || !boundedIdentifier(issue.assigneeAgentId) || !boundedIdentifier(issue.projectId)
    || (issue.status !== "todo" && issue.status !== "in_progress") || !safeText(issue.title, Number.MAX_SAFE_INTEGER, MAX_TITLE_CHARACTERS)
    || !safeText(issue.description, MAX_OBJECTIVE_BYTES)) {
    return new ContractError("OPENHANDS_ISSUE");
  }
  return {
    id: issue.id,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    projectId: issue.projectId,
    title: issue.title,
    description: issue.description,
  };
}

export function buildDispatch(context: Pick<AdapterExecutionContext, "runId" | "agent">, config: OpenHandsConfig, issue: PaperclipIssue): DispatchV1 {
  if (!keyComponent(context.runId) || !boundedIdentifier(context.agent.id)) throw new ContractError("OPENHANDS_ISSUE");
  const target = config.projectTargets[issue.projectId];
  if (!target) throw new ContractError("OPENHANDS_PROJECT");
  return {
    type: "dispatch", version: 1, runId: context.runId, taskId: issue.id, agentId: context.agent.id,
    projectId: issue.projectId, repository: target.repository, baseRef: target.baseRef, profile: target.profile,
    title: issue.title, objective: issue.description,
  };
}
