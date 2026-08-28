import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import express from "express";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { decideSuccessfulRunHandoff } from "../services/recovery/successful-run-handoff.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  describeEmbeddedPostgres,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const JWT_SECRET = "openhands-disposition-route-test-secret";
const evidence = {
  outcome: "no_change",
  repository: "voipexpert/openhands-worker-acceptance",
  baseRef: "release/v1+meta",
  commit: "b".repeat(40),
};
const expectedComment =
  "OpenHands completed with validated no-change evidence for voipexpert/openhands-worker-acceptance at release/v1+meta commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.";

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

describeEmbeddedPostgres("OpenHands transactional disposition route", () => {
  const postgres = useEmbeddedPostgres("openhands-disposition-route-", {
    resetEach: async (db) => {
      await db.execute(sql`truncate table ${companies} restart identity cascade`);
      await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: false });
    },
  });
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(postgres.db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }));
    instance.use("/api", issueRoutes(postgres.db, {} as never, {
      taskWatchdogEnqueueWakeup: null,
    }));
    instance.use(errorHandler);
    return instance;
  }

  async function postDisposition(fixture: Fixture, body: Record<string, unknown> = evidence) {
    return request(app())
      .post(`/api/issues/${fixture.issueId}/openhands-disposition`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send(body);
  }

  it("crosses JWT auth, route, transaction persistence, replay, and recovery without a corrective wake", async () => {
    const fixture = await seedFixture(postgres.db);

    const first = await postDisposition(fixture);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: fixture.issueId, status: "done", replayed: false });
    let persistedIssue = await postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    let comments = await postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(persistedIssue.status).toBe("done");
    expect(persistedIssue.checkoutRunId).toBeNull();
    expect(persistedIssue.executionRunId).toBeNull();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body: expectedComment,
      authorType: "agent",
      authorAgentId: fixture.agentId,
      createdByRunId: fixture.runId,
      metadata: expect.objectContaining({
        version: 1,
        authorizationReason: "openhands_transactional_disposition",
      }),
    });

    const replay = await postDisposition(fixture);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: fixture.issueId, status: "done", replayed: true });
    comments = await postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);

    await postgres.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.runId));
    persistedIssue = await postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    expect(decideSuccessfulRunHandoff({
      run: { id: fixture.runId, companyId: fixture.companyId, agentId: fixture.agentId, status: "succeeded", contextSnapshot: { issueId: fixture.issueId } } as never,
      issue: persistedIssue,
      agent: { id: fixture.agentId, companyId: fixture.companyId, status: "idle" } as never,
      livenessState: "completed",
      detectedProgressSummary: "Validated OpenHands evidence was persisted.",
      finalReport: "Completed.",
      nextAction: null,
      taskKey: fixture.issueId,
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
    })).toEqual({ kind: "skip", reason: "issue status done is a valid disposition" });
  });

  it("serializes concurrent same-run retries to one receipt comment", async () => {
    const fixture = await seedFixture(postgres.db);

    const [first, second] = await Promise.all([
      postDisposition(fixture),
      postDisposition(fixture),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.replayed, second.body.replayed].sort()).toEqual([false, true]);
    const comments = await postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);
  });

  it("keeps the server-constructed receipt exact and replayable when username log redaction is enabled", async () => {
    const fixture = await seedFixture(postgres.db);
    await instanceSettingsService(postgres.db).updateGeneral({ censorUsernameInLogs: true });
    const repository = `${userInfo().username}/openhands-receipt`;
    const customEvidence = { ...evidence, repository };
    const exactBody = `OpenHands completed with validated no-change evidence for ${repository} at release/v1+meta commit ${"b".repeat(40)}.`;

    const first = await postDisposition(fixture, customEvidence);
    const replay = await postDisposition(fixture, customEvidence);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const comments = await postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(exactBody);
  });

  it("rejects a mismatched-evidence replay without adding a comment", async () => {
    const fixture = await seedFixture(postgres.db);
    expect((await postDisposition(fixture)).status).toBe(200);

    const replay = await postDisposition(fixture, { ...evidence, commit: "c".repeat(40) });

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ error: "OpenHands disposition rejected." });
    const comments = await postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);
  });

  it.each([
    ["cancelled", { issue: { status: "cancelled" } }],
    ["reassigned", { issue: { assigneeAgentId: "other" } }],
    ["wrong checkout run", { issue: { checkoutRunId: "other" } }],
    ["wrong execution run", { issue: { executionRunId: "other" } }],
    ["unlocked", { issue: { executionLockedAt: null } }],
    ["different JWT run", { actor: { run: "other" } }],
    ["different JWT agent", { actor: { agent: "other", run: "other-agent" } }],
  ])("rejects stale state: %s", async (_name, mutation) => {
    const fixture = await seedFixture(postgres.db, mutation as Parameters<typeof seedFixture>[1]);

    const response = await postDisposition(fixture);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "OpenHands disposition rejected." });
    const [persistedIssue, comments] = await Promise.all([
      postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!),
      postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId)),
    ]);
    expect(persistedIssue.status).toBe(mutation.issue?.status ?? "in_progress");
    expect(comments).toHaveLength(0);
  });

  it("rejects identity and free-form fields before mutation", async () => {
    const fixture = await seedFixture(postgres.db);

    const response = await postDisposition(fixture, {
      ...evidence,
      agentId: fixture.agentId,
      runId: fixture.runId,
      summary: "caller-controlled prose",
    });

    expect(response.status).toBe(400);
    const persistedIssue = await postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    expect(persistedIssue.status).toBe("in_progress");
  });

  it("rolls back done when the receipt comment cannot be inserted", async () => {
    const fixture = await seedFixture(postgres.db);
    await postgres.db.execute(sql.raw(`
      create function openhands_disposition_test_reject_comment() returns trigger language plpgsql as $$
      begin
        raise exception 'forced receipt failure';
      end;
      $$;
      create trigger openhands_disposition_test_reject_comment
      before insert on issue_comments
      for each row execute function openhands_disposition_test_reject_comment();
    `));
    try {
      const response = await postDisposition(fixture);
      expect(response.status).toBe(500);
    } finally {
      await postgres.db.execute(sql.raw(`
        drop trigger if exists openhands_disposition_test_reject_comment on issue_comments;
        drop function if exists openhands_disposition_test_reject_comment();
      `));
    }

    const persistedIssue = await postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
    expect(persistedIssue.status).toBe("in_progress");
    expect(persistedIssue.checkoutRunId).toBe(fixture.lockedRunId);
  });
});

async function seedFixture(
  db: ReturnType<typeof import("@paperclipai/db").createDb>,
  mutation: {
    issue?: {
      status?: string;
      assigneeAgentId?: "other";
      checkoutRunId?: "other";
      executionRunId?: "other";
      executionLockedAt?: null;
    };
    actor?: { agent?: "other"; run?: "other" | "other-agent" };
  } = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const otherAgentRunId = randomUUID();
  const issueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "OpenHands disposition test",
    issuePrefix: `O${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    {
      id: agentId,
      companyId,
      name: "OpenHands agent",
      role: "engineer",
      status: "active",
      adapterType: "openhands_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: otherAgentId,
      companyId,
      name: "Other agent",
      role: "engineer",
      status: "active",
      adapterType: "openhands_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(heartbeatRuns).values([
    { id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } },
    { id: otherRunId, companyId, agentId, status: "running", contextSnapshot: { issueId } },
    { id: otherAgentRunId, companyId, agentId: otherAgentId, status: "running", contextSnapshot: { issueId } },
  ]);
  const lockedRunId = mutation.issue?.checkoutRunId === "other" ? otherRunId : runId;
  const executionRunId = mutation.issue?.executionRunId === "other" ? otherRunId : runId;
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Finalize validated OpenHands work",
    status: mutation.issue?.status ?? "in_progress",
    assigneeAgentId: mutation.issue?.assigneeAgentId === "other" ? otherAgentId : agentId,
    checkoutRunId: lockedRunId,
    executionRunId,
    executionLockedAt: mutation.issue?.executionLockedAt === null ? null : new Date(),
  });
  const actorAgentId = mutation.actor?.agent === "other" ? otherAgentId : agentId;
  const actorRunId = mutation.actor?.run === "other"
    ? otherRunId
    : mutation.actor?.run === "other-agent"
      ? otherAgentRunId
      : runId;
  return {
    companyId,
    agentId: actorAgentId,
    runId: actorRunId,
    issueId,
    lockedRunId,
    token: createLocalAgentJwt(actorAgentId, companyId, "openhands_gateway", actorRunId)!,
  };
}
