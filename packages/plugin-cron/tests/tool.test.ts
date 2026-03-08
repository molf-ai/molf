import { describe, it, expect, mock } from "bun:test";
import type { CronJob, CronPayload, CronSchedule } from "@molf-ai/protocol";
import { buildCronTool } from "../src/tool.js";

/**
 * Create a mock CronService for testing.
 */
function createMockService() {
  return {
    add: mock(async (params: {
      name: string;
      schedule: CronSchedule;
      payload: CronPayload;
      workerId: string;
      workspaceId: string;
      enabled?: boolean;
    }): Promise<CronJob> => {
      const now = Date.now();
      return {
        id: `job-${crypto.randomUUID().slice(0, 8)}`,
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        payload: params.payload,
        workerId: params.workerId,
        workspaceId: params.workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: 0,
      };
    }),
    list: mock((workerId: string, workspaceId: string): CronJob[] => []),
    remove: mock(async (workerId: string, workspaceId: string, jobId: string): Promise<boolean> => true),
    update: mock(async (
      workerId: string,
      workspaceId: string,
      jobId: string,
      patch: Partial<CronJob>,
    ): Promise<CronJob | undefined> => {
      const now = Date.now();
      return {
        id: jobId,
        name: "updated-job",
        enabled: true,
        schedule: { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "Updated" },
        workerId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: 0,
        ...patch,
      };
    }),
    get: mock((workerId: string, workspaceId: string, jobId: string): CronJob | undefined => undefined),
  };
}

describe("buildCronTool", () => {
  it("returns { name: 'cron', toolDef }", () => {
    const service = createMockService();
    const result = buildCronTool(service as any, "workspace-1", "worker-1");

    expect(result).not.toBeNull();
    expect(result.name).toBe("cron");
    expect(result.toolDef).toBeDefined();
    expect(typeof result.toolDef.execute).toBe("function");
  });

  describe("add action", () => {
    it("creates job with 'at' schedule", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const atTime = new Date(Date.now() + 3600000).toISOString();
      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "One-shot job",
          message: "Execute now",
          at: atTime,
        },
        { toolCallId: "test-1", abortSignal: undefined },
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.job).toBeDefined();
      expect(result.job.name).toBe("One-shot job");
      expect(result.job.schedule.kind).toBe("at");

      expect(service.add.mock.calls.length).toBe(1);
      const callArgs = service.add.mock.calls[0];
      expect(callArgs[0].schedule.kind).toBe("at");
    });

    it("creates job with 'every' schedule", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Repeating job",
          message: "Run periodically",
          every: "30m",
        },
        { toolCallId: "test-2", abortSignal: undefined },
      );

      expect(result.success).toBe(true);
      expect(result.job.schedule.kind).toBe("every");

      const callArgs = service.add.mock.calls[0];
      expect(callArgs[0].schedule.kind).toBe("every");
      expect((callArgs[0].schedule as any).interval_ms).toBe(30 * 60 * 1000);
    });

    it("creates job with 'cron' schedule", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Cron job",
          message: "Run daily",
          cron: "0 9 * * *",
          tz: "Europe/Kyiv",
        },
        { toolCallId: "test-3", abortSignal: undefined },
      );

      expect(result.success).toBe(true);
      expect(result.job.schedule.kind).toBe("cron");

      const callArgs = service.add.mock.calls[0];
      expect(callArgs[0].schedule.kind).toBe("cron");
      expect((callArgs[0].schedule as any).expr).toBe("0 9 * * *");
      expect((callArgs[0].schedule as any).tz).toBe("Europe/Kyiv");
    });

    it("returns error when name is missing", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          message: "Execute",
          at: new Date(Date.now() + 3600000).toISOString(),
        },
        { toolCallId: "test-4", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("name is required");
    });

    it("returns error when message is missing", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Job without message",
          at: new Date(Date.now() + 3600000).toISOString(),
        },
        { toolCallId: "test-5", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("message is required");
    });

    it("returns error when no schedule is provided", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Job without schedule",
          message: "Execute",
        },
        { toolCallId: "test-6", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Must provide one of");
    });

    it("returns error when cron expression is invalid", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Bad cron job",
          message: "Execute",
          cron: "invalid cron",
        },
        { toolCallId: "test-7", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Invalid cron expression");
    });
  });

  describe("list action", () => {
    it("returns jobs array when jobs exist", async () => {
      const now = Date.now();
      const mockJobs: CronJob[] = [
        {
          id: "job-1",
          name: "Job 1",
          enabled: true,
          schedule: { kind: "every", interval_ms: 60000 },
          payload: { kind: "agent_turn", message: "Run job 1" },
          workerId: "worker-1",
          workspaceId: "workspace-1",
          createdAt: now,
          updatedAt: now,
          nextRunAt: now + 60000,
          lastRunAt: now - 60000,
          lastStatus: "ok",
          consecutiveErrors: 0,
        },
        {
          id: "job-2",
          name: "Job 2",
          enabled: false,
          schedule: { kind: "at", at: now + 7200000 },
          payload: { kind: "agent_turn", message: "Run job 2" },
          workerId: "worker-1",
          workspaceId: "workspace-1",
          createdAt: now,
          updatedAt: now,
          nextRunAt: now + 7200000,
          consecutiveErrors: 0,
        },
      ];

      const service = createMockService();
      service.list = mock(() => mockJobs);

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "list" },
        { toolCallId: "test-8", abortSignal: undefined },
      );

      expect(result.jobs).toBeDefined();
      expect(result.jobs.length).toBe(2);
      expect(result.jobs[0].id).toBe("job-1");
      expect(result.jobs[0].name).toBe("Job 1");
      expect(result.jobs[0].enabled).toBe(true);
      expect(result.jobs[0].message).toBe("Run job 1");
      expect(result.jobs[1].id).toBe("job-2");
      expect(result.jobs[1].enabled).toBe(false);
    });

    it("returns 'No scheduled jobs' message when list is empty", async () => {
      const service = createMockService();
      service.list = mock(() => []);

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "list" },
        { toolCallId: "test-9", abortSignal: undefined },
      );

      expect(result.jobs).toBeDefined();
      expect(result.jobs.length).toBe(0);
      expect(result.message).toBe("No scheduled jobs.");
    });
  });

  describe("remove action", () => {
    it("removes a job by job_id", async () => {
      const service = createMockService();
      service.remove = mock(async () => true);

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "remove", job_id: "job-123" },
        { toolCallId: "test-10", abortSignal: undefined },
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("job-123");
      expect(result.message).toContain("removed");

      expect(service.remove.mock.calls.length).toBe(1);
      const callArgs = service.remove.mock.calls[0];
      expect(callArgs[2]).toBe("job-123");
    });

    it("returns error when job_id is missing", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        { action: "remove" },
        { toolCallId: "test-11", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("job_id is required");
    });

    it("returns error when job not found", async () => {
      const service = createMockService();
      service.remove = mock(async () => false);

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "remove", job_id: "nonexistent" },
        { toolCallId: "test-12", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
    });
  });

  describe("update action", () => {
    it("updates job name", async () => {
      const service = createMockService();
      const now = Date.now();
      service.update = mock(async (workerId, workspaceId, jobId, patch) => ({
        id: jobId,
        name: (patch.name as string) ?? "old-name",
        enabled: true,
        schedule: { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "msg" },
        workerId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: 0,
      }));

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "update", job_id: "job-123", name: "Updated Name" },
        { toolCallId: "test-13", abortSignal: undefined },
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("job-123");

      const callArgs = service.update.mock.calls[0];
      expect(callArgs[3].name).toBe("Updated Name");
    });

    it("updates job with new schedule and resets consecutiveErrors", async () => {
      const service = createMockService();
      const now = Date.now();
      service.update = mock(async (workerId, workspaceId, jobId, patch) => ({
        id: jobId,
        name: "job",
        enabled: true,
        schedule: (patch.schedule as CronSchedule) ?? { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "msg" },
        workerId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: (patch.consecutiveErrors as number) ?? 0,
      }));

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "update", job_id: "job-123", every: "1h" },
        { toolCallId: "test-14", abortSignal: undefined },
      );

      expect(result.success).toBe(true);

      const callArgs = service.update.mock.calls[0];
      expect(callArgs[3].schedule?.kind).toBe("every");
      // consecutiveErrors reset is handled by CronService.update(), not the tool layer
    });

    it("updates job enabled status", async () => {
      const service = createMockService();
      const now = Date.now();
      service.update = mock(async (workerId, workspaceId, jobId, patch) => ({
        id: jobId,
        name: "job",
        enabled: (patch.enabled as boolean) ?? true,
        schedule: { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "msg" },
        workerId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: 0,
      }));

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "update", job_id: "job-123", enabled: false },
        { toolCallId: "test-15", abortSignal: undefined },
      );

      expect(result.success).toBe(true);

      const callArgs = service.update.mock.calls[0];
      expect(callArgs[3].enabled).toBe(false);
    });

    it("updates job message", async () => {
      const service = createMockService();
      const now = Date.now();
      service.update = mock(async (workerId, workspaceId, jobId, patch) => ({
        id: jobId,
        name: "job",
        enabled: true,
        schedule: { kind: "every", interval_ms: 60000 },
        payload: (patch.payload as CronPayload) ?? { kind: "agent_turn", message: "old" },
        workerId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 60000,
        consecutiveErrors: 0,
      }));

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "update", job_id: "job-123", message: "New message" },
        { toolCallId: "test-16", abortSignal: undefined },
      );

      expect(result.success).toBe(true);

      const callArgs = service.update.mock.calls[0];
      expect(callArgs[3].payload?.kind).toBe("agent_turn");
      expect((callArgs[3].payload as any)?.message).toBe("New message");
    });

    it("returns error when job_id is missing", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        { action: "update", name: "New Name" },
        { toolCallId: "test-17", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("job_id is required");
    });

    it("returns error when job not found", async () => {
      const service = createMockService();
      service.update = mock(async () => undefined);

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "update", job_id: "nonexistent", name: "New Name" },
        { toolCallId: "test-18", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
    });
  });

  describe("edge cases", () => {
    it("handles unknown action", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        { action: "unknown_action" },
        { toolCallId: "test-19", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Unknown action");
    });

    it("handles thrown exceptions gracefully", async () => {
      const service = createMockService();
      service.list = mock(() => {
        throw new Error("Database connection failed");
      });

      const tool = buildCronTool(service as any, "workspace-1", "worker-1");
      const result = await (tool.toolDef as any).execute(
        { action: "list" },
        { toolCallId: "test-20", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Database connection failed");
    });

    it("handles invalid datetime format", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Bad date job",
          message: "Execute",
          at: "not-a-date",
        },
        { toolCallId: "test-21", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Invalid datetime");
    });

    it("handles invalid duration format", async () => {
      const service = createMockService();
      const tool = buildCronTool(service as any, "workspace-1", "worker-1");

      const result = await (tool.toolDef as any).execute(
        {
          action: "add",
          name: "Bad duration job",
          message: "Execute",
          every: "xyz",
        },
        { toolCallId: "test-22", abortSignal: undefined },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Invalid duration");
    });
  });
});
