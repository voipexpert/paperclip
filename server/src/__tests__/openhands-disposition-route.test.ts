import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  routineRuns,
  routines,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { decideSuccessfulRunHandoff } from "../services/recovery/successful-run-handoff.js";
import { externalObjectService } from "../services/external-objects.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueReferenceService } from "../services/issue-references.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { routineService } from "../services/routines.js";
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

  function app(completionLifecycleHooks?: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(postgres.db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }));
    instance.use("/api", issueRoutes(postgres.db, {} as never, {
      taskWatchdogEnqueueWakeup: null,
      completionLifecycleHooks,
    } as never));
    instance.use(errorHandler);
    return instance;
  }

  function lifecycleHarness() {
    const references = issueReferenceService(postgres.db);
    const externalObjects = externalObjectService(postgres.db, { enabled: false });
    const interactions = issueThreadInteractionService(postgres.db);
    const detached: Promise<void>[] = [];
    let drained = 0;
    const hooks = {
      syncRoutineRunStatusForIssue: vi.fn(async (issueId: string) =>
        routineService(postgres.db).syncRunStatusForIssue(issueId)),
      reportRunActivity: vi.fn(async () => undefined),
      syncCommentReferences: vi.fn((commentId: string) => references.syncComment(commentId)),
      syncCommentExternalObjects: vi.fn((commentId: string) => externalObjects.syncCommentSafely(commentId)),
      expireRequestConfirmationsSupersededByComment: vi.fn(
        interactions.expireRequestConfirmationsSupersededByComment,
      ),
      expirePendingInteractionsForTerminalIssue: vi.fn(
        interactions.expirePendingInteractionsForTerminalIssue,
      ),
      destroyReusableSandboxLeases: vi.fn(async () => []),
      reconcileTaskWatchdogs: vi.fn(async () => undefined),
      wakeup: vi.fn(async () => null),
      scheduleDetachedLifecycle: vi.fn((effect: () => Promise<void>) => {
        detached.push(effect());
      }),
    };
    return {
      hooks,
      async drain() {
        while (drained < detached.length) {
          await detached[drained++];
        }
      },
    };
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

  it("runs the normal completion lifecycle once and skips every effect on receipt replay", async () => {
    const fixture = await seedFixture(postgres.db, { lifecycle: true });
    const lifecycle = lifecycleHarness();
    const lifecycleHooks = lifecycle.hooks;
    const {
      destroyReusableSandboxLeases,
      expirePendingInteractionsForTerminalIssue,
      expireRequestConfirmationsSupersededByComment,
      reconcileTaskWatchdogs,
      reportRunActivity,
      scheduleDetachedLifecycle,
      syncCommentExternalObjects,
      syncCommentReferences,
      syncRoutineRunStatusForIssue,
      wakeup,
    } = lifecycleHooks;

    const first = await request(app(lifecycleHooks))
      .post(`/api/issues/${fixture.issueId}/openhands-disposition`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send(evidence);

    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    await lifecycle.drain();
    expect(syncRoutineRunStatusForIssue).toHaveBeenCalledOnce();
    expect(syncRoutineRunStatusForIssue).toHaveBeenCalledWith(fixture.issueId);
    expect(reportRunActivity).toHaveBeenCalledOnce();
    expect(reportRunActivity).toHaveBeenCalledWith(fixture.runId);
    expect(syncCommentReferences).toHaveBeenCalledOnce();
    expect(syncCommentReferences).toHaveBeenCalledWith(first.body.commentId);
    expect(syncCommentExternalObjects).toHaveBeenCalledOnce();
    expect(syncCommentExternalObjects).toHaveBeenCalledWith(first.body.commentId);
    expect(expireRequestConfirmationsSupersededByComment).toHaveBeenCalledOnce();
    expect(expirePendingInteractionsForTerminalIssue).toHaveBeenCalledOnce();
    expect(scheduleDetachedLifecycle).toHaveBeenCalledOnce();
    expect(destroyReusableSandboxLeases).toHaveBeenCalledOnce();
    expect(destroyReusableSandboxLeases).toHaveBeenCalledWith({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      executionWorkspaceId: null,
      failureReason: "issue_terminal_done",
    });
    expect(reconcileTaskWatchdogs).toHaveBeenCalledOnce();
    expect(reconcileTaskWatchdogs).toHaveBeenCalledWith(
      fixture.companyId,
      fixture.issueId,
      { runId: fixture.runId },
    );
    expect(wakeup).toHaveBeenCalledWith(
      fixture.otherAgentId,
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        idempotencyKey: expect.stringMatching(/^issue_blockers_resolved:state:/),
        payload: expect.objectContaining({
          issueId: fixture.dependentIssueId,
          resolvedBlockerIssueId: fixture.issueId,
        }),
      }),
    );
    expect(wakeup).toHaveBeenCalledWith(
      fixture.otherAgentId,
      expect.objectContaining({
        reason: "issue_children_completed",
        idempotencyKey: `issue_children_completed:${fixture.parentIssueId}:${fixture.issueId}`,
        payload: expect.objectContaining({
          issueId: fixture.parentIssueId,
          completedChildIssueId: fixture.issueId,
        }),
      }),
    );

    const [routineRun] = await postgres.db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, fixture.routineRunId!));
    expect(routineRun).toMatchObject({ status: "completed", failureReason: null });
    expect(routineRun?.completedAt).toBeInstanceOf(Date);
    const lifecycleActivities = await postgres.db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, fixture.issueId),
        inArray(activityLog.action, ["issue.updated", "issue.comment_added"]),
      ));
    expect(lifecycleActivities).toHaveLength(2);
    expect(lifecycleActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.updated",
        actorType: "agent",
        actorId: fixture.agentId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        details: expect.objectContaining({
          authorizationReason: "openhands_transactional_disposition",
          changes: expect.objectContaining({ status: { from: "in_progress", to: "done" } }),
        }),
      }),
      expect.objectContaining({
        action: "issue.comment_added",
        actorType: "agent",
        actorId: fixture.agentId,
        agentId: fixture.agentId,
        runId: fixture.runId,
        details: expect.objectContaining({
          commentId: first.body.commentId,
          authorizationReason: "openhands_transactional_disposition",
        }),
      }),
    ]));
    const lifecycleInteractions = await postgres.db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, fixture.issueId));
    expect(lifecycleInteractions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.supersedableConfirmationId,
        status: "expired",
        result: expect.objectContaining({ outcome: "issue_closed" }),
      }),
      expect.objectContaining({
        id: fixture.terminalInteractionId,
        status: "expired",
        result: expect.objectContaining({ outcome: "issue_closed" }),
      }),
    ]));

    const replay = await request(app(lifecycleHooks))
      .post(`/api/issues/${fixture.issueId}/openhands-disposition`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send(evidence);

    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    await lifecycle.drain();
    expect(syncRoutineRunStatusForIssue).toHaveBeenCalledTimes(1);
    expect(reportRunActivity).toHaveBeenCalledTimes(1);
    expect(syncCommentReferences).toHaveBeenCalledTimes(1);
    expect(syncCommentExternalObjects).toHaveBeenCalledTimes(1);
    expect(expireRequestConfirmationsSupersededByComment).toHaveBeenCalledTimes(1);
    expect(expirePendingInteractionsForTerminalIssue).toHaveBeenCalledTimes(1);
    expect(scheduleDetachedLifecycle).toHaveBeenCalledTimes(1);
    expect(destroyReusableSandboxLeases).toHaveBeenCalledTimes(1);
    expect(reconcileTaskWatchdogs).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(2);
    const replayActivities = await postgres.db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, fixture.issueId),
        inArray(activityLog.action, ["issue.updated", "issue.comment_added"]),
      ));
    expect(replayActivities).toHaveLength(2);
  });

  it("uses the shared lifecycle exactly once for generic PATCH completion without legacy duplicates", async () => {
    const fixture = await seedFixture(postgres.db, { lifecycle: true });
    const lifecycle = lifecycleHarness();
    const response = await request(app(lifecycle.hooks))
      .patch(`/api/issues/${fixture.issueId}`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send({ status: "done", comment: "Validated completion evidence." });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: fixture.issueId, status: "done" });
    await lifecycle.drain();

    expect(lifecycle.hooks.syncRoutineRunStatusForIssue).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.reportRunActivity).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.syncCommentReferences).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.syncCommentExternalObjects).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.expireRequestConfirmationsSupersededByComment).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.expirePendingInteractionsForTerminalIssue).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.destroyReusableSandboxLeases).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.reconcileTaskWatchdogs).toHaveBeenCalledOnce();
    expect(lifecycle.hooks.wakeup).toHaveBeenCalledTimes(2);
    expect(lifecycle.hooks.scheduleDetachedLifecycle).toHaveBeenCalledTimes(2);

    const [activities, persistedInteractions, comments] = await Promise.all([
      postgres.db.select().from(activityLog).where(and(
        eq(activityLog.entityId, fixture.issueId),
        inArray(activityLog.action, ["issue.updated", "issue.comment_added"]),
      )),
      postgres.db.select().from(issueThreadInteractions).where(
        eq(issueThreadInteractions.issueId, fixture.issueId),
      ),
      postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId)),
    ]);
    expect(activities).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect(persistedInteractions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.supersedableConfirmationId, status: "expired" }),
      expect.objectContaining({ id: fixture.terminalInteractionId, status: "expired" }),
    ]));
  });

  it.each([
    ["comment reference sync", "syncCommentReferences"],
    ["comment external-object sync", "syncCommentExternalObjects"],
    ["comment confirmation expiry", "expireRequestConfirmationsSupersededByComment"],
  ] as const)("keeps generic PATCH completion lifecycle running when %s fails", async (_label, failingHook) => {
    const fixture = await seedFixture(postgres.db, { lifecycle: true });
    const lifecycle = lifecycleHarness();
    const injectedFailure = vi.fn(async () => {
      throw new Error(`injected ${failingHook} failure`);
    });
    const hooks = {
      ...lifecycle.hooks,
      [failingHook]: injectedFailure,
    };

    const response = await request(app(hooks))
      .patch(`/api/issues/${fixture.issueId}`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send({ status: "done", comment: "Validated completion evidence." });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: fixture.issueId, status: "done" });
    await lifecycle.drain();

    expect(hooks.syncCommentReferences).toHaveBeenCalledOnce();
    expect(hooks.syncCommentExternalObjects).toHaveBeenCalledOnce();
    expect(hooks.expireRequestConfirmationsSupersededByComment).toHaveBeenCalledOnce();
    expect(hooks.syncRoutineRunStatusForIssue).toHaveBeenCalledOnce();
    expect(hooks.reportRunActivity).toHaveBeenCalledOnce();
    expect(hooks.expirePendingInteractionsForTerminalIssue).toHaveBeenCalledOnce();
    expect(hooks.destroyReusableSandboxLeases).toHaveBeenCalledOnce();
    expect(hooks.reconcileTaskWatchdogs).toHaveBeenCalledOnce();
    expect(hooks.wakeup).toHaveBeenCalledTimes(2);
    expect(hooks.scheduleDetachedLifecycle).toHaveBeenCalledTimes(2);

    const [persistedIssue, comments, activities] = await Promise.all([
      postgres.db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]),
      postgres.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId)),
      postgres.db.select().from(activityLog).where(and(
        eq(activityLog.entityId, fixture.issueId),
        inArray(activityLog.action, ["issue.updated", "issue.comment_added"]),
      )),
    ]);
    expect(persistedIssue?.status).toBe("done");
    expect(comments).toHaveLength(1);
    expect(activities).toHaveLength(2);
  });

  it("isolates a post-commit hook failure and never retries lifecycle mutation on receipt replay", async () => {
    const fixture = await seedFixture(postgres.db);
    const hookFailureDetail = "private routine hook failure";
    const lifecycle = lifecycleHarness();
    const syncRoutineRunStatusForIssue = vi.fn(async () => {
      throw new Error(hookFailureDetail);
    });
    const lifecycleHooks = {
      ...lifecycle.hooks,
      syncRoutineRunStatusForIssue,
    };

    const first = await request(app(lifecycleHooks))
      .post(`/api/issues/${fixture.issueId}/openhands-disposition`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send(evidence);
    const replay = await request(app(lifecycleHooks))
      .post(`/api/issues/${fixture.issueId}/openhands-disposition`)
      .set("Authorization", `Bearer ${fixture.token}`)
      .send(evidence);
    await lifecycle.drain();

    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(JSON.stringify(first.body)).not.toContain(hookFailureDetail);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(syncRoutineRunStatusForIssue).toHaveBeenCalledTimes(1);
    expect(lifecycle.hooks.reportRunActivity).toHaveBeenCalledTimes(1);
    expect(lifecycle.hooks.destroyReusableSandboxLeases).toHaveBeenCalledTimes(1);
    expect(lifecycle.hooks.reconcileTaskWatchdogs).toHaveBeenCalledTimes(1);
    const comments = await postgres.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.issueId));
    expect(comments).toHaveLength(1);
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
    lifecycle?: boolean;
  } = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const otherAgentRunId = randomUUID();
  const issueId = randomUUID();
  const parentIssueId = randomUUID();
  const dependentIssueId = randomUUID();
  const routineId = randomUUID();
  const routineRunId = randomUUID();
  const supersedableConfirmationId = randomUUID();
  const terminalInteractionId = randomUUID();
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
  if (mutation.lifecycle) {
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "OpenHands lifecycle routine",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-08-28T00:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Parent awaiting OpenHands child",
        status: "in_progress",
        assigneeAgentId: otherAgentId,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Dependent awaiting OpenHands blocker",
        status: "blocked",
        assigneeAgentId: otherAgentId,
      },
    ]);
  }
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
    ...(mutation.lifecycle
      ? {
          parentId: parentIssueId,
          originKind: "routine_execution",
          originId: routineId,
          originRunId: routineRunId,
        }
      : {}),
  });
  if (mutation.lifecycle) {
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });
    await db.update(routineRuns).set({ linkedIssueId: issueId }).where(eq(routineRuns.id, routineRunId));
    await db.insert(issueThreadInteractions).values([
      {
        id: supersedableConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: otherAgentId,
        sourceRunId: otherAgentRunId,
        payload: {
          version: 1,
          prompt: "Is this completion ready?",
          supersedeOnUserComment: true,
        },
      },
      {
        id: terminalInteractionId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: otherAgentId,
        sourceRunId: otherAgentRunId,
        payload: {
          version: 1,
          supersedeOnUserComment: false,
          questions: [{
            id: "remaining-question",
            prompt: "What should happen next?",
            selectionMode: "single",
            options: [{ id: "wait", label: "Wait" }],
          }],
        },
      },
    ]);
  }
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
    otherAgentId,
    parentIssueId: mutation.lifecycle ? parentIssueId : null,
    dependentIssueId: mutation.lifecycle ? dependentIssueId : null,
    routineRunId: mutation.lifecycle ? routineRunId : null,
    supersedableConfirmationId: mutation.lifecycle ? supersedableConfirmationId : null,
    terminalInteractionId: mutation.lifecycle ? terminalInteractionId : null,
    lockedRunId,
    token: createLocalAgentJwt(actorAgentId, companyId, "openhands_gateway", actorRunId)!,
  };
}
