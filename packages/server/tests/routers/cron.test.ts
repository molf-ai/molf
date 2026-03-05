import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../../src/session-mgr.js";
import { ConnectionRegistry } from "../../src/connection-registry.js";
import { EventBus } from "../../src/event-bus.js";
import { ToolDispatch } from "../../src/tool-dispatch.js";
import { UploadDispatch } from "../../src/upload-dispatch.js";
import { FsDispatch } from "../../src/fs-dispatch.js";
import { InlineMediaCache } from "../../src/inline-media-cache.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { WorkspaceStore } from "../../src/workspace-store.js";
import { WorkspaceNotifier } from "../../src/workspace-notifier.js";
import { ApprovalGate } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { CronStore } from "../../src/cron/store.js";
import { CronService } from "../../src/cron/service.js";
import { appRouter } from "../../src/router.js";
import { initTRPC } from "@trpc/server";
import type { ServerContext } from "../../src/context.js";
import { makeProviderState } from "../_provider-state.js";
import { getLogger } from "@logtape/logtape";

const t = initTRPC.context<ServerContext>().create();
const createCallerFactory = t.createCallerFactory;

let tmp: TmpDir;
let cronService: CronService;
let workspaceStore: WorkspaceStore;

const WORKER_ID = "cron-test-worker";
const WORKSPACE_ID = "cron-test-ws";

function makeCaller() {
  const createCaller = createCallerFactory(appRouter);
  const sessionMgr = new SessionManager(tmp.path);
  const connectionRegistry = new ConnectionRegistry();
  const eventBus = new EventBus();
  const toolDispatch = new ToolDispatch();
  const uploadDispatch = new UploadDispatch();
  const fsDispatch = new FsDispatch();
  const inlineMediaCache = new InlineMediaCache();
  const approvalGate = new ApprovalGate(new RulesetStorage(tmp.path), eventBus);
  const agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(), "gemini/test", inlineMediaCache, approvalGate,
    workspaceStore,
  );

  return createCaller({
    token: "valid-token",
    clientId: "test-client",
    sessionMgr,
    connectionRegistry,
    agentRunner,
    eventBus,
    toolDispatch,
    uploadDispatch,
    fsDispatch,
    inlineMediaCache,
    approvalGate,
    workspaceStore,
    workspaceNotifier: new WorkspaceNotifier(),
    cronService,
    providerState: makeProviderState(),
    dataDir: tmp.path,
  });
}

beforeAll(() => {
  tmp = createTmpDir("molf-cron-router-");
  workspaceStore = new WorkspaceStore(tmp.path);
  const cronStore = new CronStore(tmp.path);
  cronService = new CronService({
    store: cronStore,
    connectionRegistry: new ConnectionRegistry(),
    sessionMgr: new SessionManager(tmp.path),
    workspaceStore,
    workspaceNotifier: new WorkspaceNotifier(),
    logger: getLogger(["molf", "cron"]),
  });
});

afterAll(() => {
  cronService.shutdown();
  tmp.cleanup();
});

function makeSchedule() {
  return { kind: "every" as const, interval_ms: 3600_000 };
}

function makePayload(message = "Check status") {
  return { kind: "agent_turn" as const, message };
}

describe("cron router", () => {
  test("list returns empty for no jobs", async () => {
    const caller = makeCaller();
    const result = await caller.cron.list({ workerId: WORKER_ID, workspaceId: WORKSPACE_ID });
    expect(result).toEqual([]);
  });

  test("add creates a new cron job", async () => {
    const caller = makeCaller();
    const job = await caller.cron.add({
      name: "hourly-check",
      schedule: makeSchedule(),
      payload: makePayload(),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(job.name).toBe("hourly-check");
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe("every");
    expect(job.id).toBeTruthy();
  });

  test("list returns added jobs", async () => {
    const caller = makeCaller();
    const jobs = await caller.cron.list({ workerId: WORKER_ID, workspaceId: WORKSPACE_ID });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j) => j.name === "hourly-check")).toBe(true);
  });

  test("update modifies job name", async () => {
    const caller = makeCaller();
    const job = await caller.cron.add({
      name: "to-update",
      schedule: makeSchedule(),
      payload: makePayload("Update me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const result = await caller.cron.update({
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
      name: "updated-name",
    });

    expect(result.success).toBe(true);
    expect(result.job!.name).toBe("updated-name");
  });

  test("update disables job", async () => {
    const caller = makeCaller();
    const job = await caller.cron.add({
      name: "to-disable",
      schedule: makeSchedule(),
      payload: makePayload("Disable me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const result = await caller.cron.update({
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
      enabled: false,
    });

    expect(result.success).toBe(true);
    expect(result.job!.enabled).toBe(false);
  });

  test("update nonexistent job returns success=false", async () => {
    const caller = makeCaller();
    const result = await caller.cron.update({
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: "nonexistent-id",
      name: "nope",
    });
    expect(result.success).toBe(false);
  });

  test("remove deletes job", async () => {
    const caller = makeCaller();
    const job = await caller.cron.add({
      name: "to-remove",
      schedule: makeSchedule(),
      payload: makePayload("Remove me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const result = await caller.cron.remove({
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
    });
    expect(result.success).toBe(true);

    // Verify it's gone
    const jobs = await caller.cron.list({ workerId: WORKER_ID, workspaceId: WORKSPACE_ID });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
  });

  test("remove nonexistent job returns success=false", async () => {
    const caller = makeCaller();
    const result = await caller.cron.remove({
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: "nonexistent-id",
    });
    expect(result.success).toBe(false);
  });

  test("add with disabled creates job but not scheduled", async () => {
    const caller = makeCaller();
    const job = await caller.cron.add({
      name: "disabled-job",
      schedule: makeSchedule(),
      payload: makePayload("Disabled"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      enabled: false,
    });

    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeUndefined();
  });
});
