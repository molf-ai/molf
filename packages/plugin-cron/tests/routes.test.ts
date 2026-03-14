import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { join } from "node:path";

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { CronStore } from "../src/store.js";
import { CronService } from "../src/service.js";

// Import the plugin to access the routes via the plugin system
import cronPlugin from "../src/index.js";

let tmp: TmpDir;
let service: CronService;
let routes: Record<string, { handler: Function }>;
let ctx: { service: CronService };

const WORKER_ID = "cron-test-worker";
const WORKSPACE_ID = "cron-test-ws";

beforeAll(() => {
  tmp = createTmpDir("molf-cron-routes-");

  // Extract the routes by capturing what addRoutes receives
  let capturedRoutes: any;
  const mockApi = {
    on: () => {},
    addTool: () => {},
    addSessionTool: () => {},
    addRoutes: (r: any, c: any) => { capturedRoutes = r; ctx = c; },
    addService: () => {},
    config: undefined,
    dataPath: (wId?: string, wsId?: string) => {
      const base = join(tmp.path, "plugins", "cron");
      if (wId == null) return base;
      if (wsId == null) return join(base, "workers", wId);
      return join(base, "workers", wId, "workspaces", wsId);
    },
    serverDataDir: tmp.path,
    sessionMgr: {} as any,
    eventBus: {} as any,
    agentRunner: {
      prompt: async () => ({ messageId: "test" }),
    } as any,
    connectionRegistry: { getWorkerIds: () => [] } as any,
    workspaceStore: { getConfig: () => ({ model: "test" }) } as any,
    workspaceNotifier: { subscribe: () => () => {} } as any,
  };

  cronPlugin.server!(mockApi as any);
  routes = capturedRoutes;
  service = ctx.service;
});

afterAll(() => {
  service.shutdown();
  tmp.cleanup();
});

function makeSchedule() {
  return { kind: "every" as const, interval_ms: 3600_000 };
}

function makePayload(message = "Check status") {
  return { kind: "agent_turn" as const, message };
}

describe("cron plugin routes", () => {
  test("list returns empty for no jobs", () => {
    const result = routes.list.handler({ input: { workerId: WORKER_ID, workspaceId: WORKSPACE_ID }, context: ctx });
    expect(result).toEqual([]);
  });

  test("add creates a new cron job", async () => {
    const job = await routes.add.handler({ input: {
      name: "hourly-check",
      schedule: makeSchedule(),
      payload: makePayload(),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    }, context: ctx });

    expect(job.name).toBe("hourly-check");
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe("every");
    expect(job.id).toBeTruthy();
  });

  test("list returns added jobs", () => {
    const jobs = routes.list.handler({ input: { workerId: WORKER_ID, workspaceId: WORKSPACE_ID }, context: ctx });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j: any) => j.name === "hourly-check")).toBe(true);
  });

  test("update modifies job name", async () => {
    const job = await routes.add.handler({ input: {
      name: "to-update",
      schedule: makeSchedule(),
      payload: makePayload("Update me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    }, context: ctx });

    const result = await routes.update.handler({ input: {
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
      name: "updated-name",
    }, context: ctx });

    expect(result.success).toBe(true);
    expect(result.job!.name).toBe("updated-name");
  });

  test("update disables job", async () => {
    const job = await routes.add.handler({ input: {
      name: "to-disable",
      schedule: makeSchedule(),
      payload: makePayload("Disable me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    }, context: ctx });

    const result = await routes.update.handler({ input: {
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
      enabled: false,
    }, context: ctx });

    expect(result.success).toBe(true);
    expect(result.job!.enabled).toBe(false);
  });

  test("update nonexistent job returns success=false", async () => {
    const result = await routes.update.handler({ input: {
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: "nonexistent-id",
      name: "nope",
    }, context: ctx });
    expect(result.success).toBe(false);
  });

  test("remove deletes job", async () => {
    const job = await routes.add.handler({ input: {
      name: "to-remove",
      schedule: makeSchedule(),
      payload: makePayload("Remove me"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
    }, context: ctx });

    const result = await routes.remove.handler({ input: {
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: job.id,
    }, context: ctx });
    expect(result.success).toBe(true);

    // Verify it's gone
    const jobs = routes.list.handler({ input: { workerId: WORKER_ID, workspaceId: WORKSPACE_ID }, context: ctx });
    expect(jobs.find((j: any) => j.id === job.id)).toBeUndefined();
  });

  test("remove nonexistent job returns success=false", async () => {
    const result = await routes.remove.handler({ input: {
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      jobId: "nonexistent-id",
    }, context: ctx });
    expect(result.success).toBe(false);
  });

  test("add with disabled creates job but not scheduled", async () => {
    const job = await routes.add.handler({ input: {
      name: "disabled-job",
      schedule: makeSchedule(),
      payload: makePayload("Disabled"),
      workerId: WORKER_ID,
      workspaceId: WORKSPACE_ID,
      enabled: false,
    }, context: ctx });

    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeUndefined();
  });
});
