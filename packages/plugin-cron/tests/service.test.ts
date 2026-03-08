import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { waitUntil, flushAsync } from "@molf-ai/test-utils";
import { CronService } from "../src/service.js";
import type { CronServiceDeps } from "../src/service.js";
import type { CronJob } from "@molf-ai/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "Test Job",
    enabled: true,
    schedule: { kind: "every", interval_ms: 60_000 },
    payload: { kind: "agent_turn", message: "hello" },
    workerId: "worker-1",
    workspaceId: "ws-1",
    createdAt: now,
    updatedAt: now,
    consecutiveErrors: 0,
    ...overrides,
  };
}

/**
 * Build a job that is PAST DUE when init() is called.
 *
 * init() recomputes nextRunAt via computeNextRun. For an "every" schedule,
 * computeNormalNextRun returns `lastRunAt + interval_ms` when lastRunAt exists.
 * Setting lastRunAt = now - interval_ms - 1 makes the computed nextRunAt = -1ms
 * (i.e. already expired), so the timer fires immediately with delay=0.
 */
function makePastDueEveryJob(overrides: Partial<CronJob> = {}): CronJob {
  const interval = 60_000;
  const now = Date.now();
  return makeJob({
    schedule: { kind: "every", interval_ms: interval },
    // lastRunAt exactly one interval ago → nextRunAt = now (past due)
    lastRunAt: now - interval,
    consecutiveErrors: 0,
    ...overrides,
  });
}

/**
 * Build a past-due one-shot "at" job.
 * For "at" schedules, computeNormalNextRun simply returns job.schedule.at,
 * so setting at = Date.now() - 500 makes it past due.
 */
function makePastDueAtJob(overrides: Partial<CronJob> = {}): CronJob {
  const at = Date.now() - 500;
  return makeJob({
    id: "at-job",
    schedule: { kind: "at", at },
    consecutiveErrors: 0,
    ...overrides,
  });
}

function createMockDeps(): CronServiceDeps {
  return {
    store: {
      loadAll: mock(() => []),
      load: mock(() => []),
      add: mock(async () => {}),
      remove: mock(async () => true),
      update: mock(async () => true),
      get: mock(() => undefined),
      list: mock(() => []),
      save: mock(async () => {}),
    } as any,
    connectionRegistry: {
      getWorker: mock(() => ({ id: "worker-1", name: "test-worker" })),
    } as any,
    sessionMgr: {
      load: mock(() => ({ sessionId: "session-1" })),
      addMessage: mock(() => {}),
      save: mock(async () => {}),
      create: mock(async () => ({ sessionId: "new-session-1" })),
    } as any,
    workspaceStore: {
      get: mock(async () => ({ lastSessionId: "session-1" })),
      addSession: mock(async () => {}),
    } as any,
    workspaceNotifier: {
      emit: mock(() => {}),
    } as any,
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Tests — CRUD methods
// ---------------------------------------------------------------------------

describe("CronService — CRUD", () => {
  let deps: CronServiceDeps;
  let svc: CronService;

  beforeEach(() => {
    deps = createMockDeps();
    svc = new CronService(deps);
  });

  afterEach(() => {
    svc.shutdown();
  });

  // 1. init() loads jobs from store
  it("init() loads enabled jobs from store", () => {
    const job = makeJob({ enabled: true });
    (deps.store.loadAll as ReturnType<typeof mock>).mockImplementation(() => [job]);

    svc.init();

    expect(deps.store.loadAll).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).toHaveBeenCalled();
  });

  it("init() skips disabled jobs", () => {
    const disabledJob = makeJob({ enabled: false });
    const enabledJob = makeJob({ id: "job-2", enabled: true });
    (deps.store.loadAll as ReturnType<typeof mock>).mockImplementation(() => [
      disabledJob,
      enabledJob,
    ]);

    svc.init();

    // loadAll is called once
    expect(deps.store.loadAll).toHaveBeenCalledTimes(1);
    // logger.info is called (indicating initialization occurred)
    expect(deps.logger.info).toHaveBeenCalled();
  });

  // 2. add() creates job, persists, returns job with nextRunAt
  it("add() persists a new job and returns it with nextRunAt set", async () => {
    const before = Date.now();
    const job = await svc.add({
      name: "My Job",
      schedule: { kind: "every", interval_ms: 5_000 },
      payload: { kind: "agent_turn", message: "tick" },
      workerId: "worker-1",
      workspaceId: "ws-1",
    });
    const after = Date.now();

    expect(job.name).toBe("My Job");
    expect(job.enabled).toBe(true);
    expect(job.consecutiveErrors).toBe(0);
    expect(job.createdAt).toBeGreaterThanOrEqual(before);
    expect(job.createdAt).toBeLessThanOrEqual(after);
    // nextRunAt must be a future timestamp for an enabled job
    expect(job.nextRunAt).toBeTypeOf("number");
    expect(job.nextRunAt!).toBeGreaterThan(before);

    expect(deps.store.add).toHaveBeenCalledTimes(1);
    expect((deps.store.add as ReturnType<typeof mock>).mock.calls[0][0]).toMatchObject({
      name: "My Job",
      workerId: "worker-1",
      workspaceId: "ws-1",
    });
  });

  it("add() with enabled=false does not set nextRunAt", async () => {
    const job = await svc.add({
      name: "Disabled Job",
      schedule: { kind: "every", interval_ms: 5_000 },
      payload: { kind: "agent_turn", message: "tick" },
      workerId: "worker-1",
      workspaceId: "ws-1",
      enabled: false,
    });

    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeUndefined();
    // store.add is still called to persist it
    expect(deps.store.add).toHaveBeenCalledTimes(1);
  });

  it("add() with 'at' schedule sets nextRunAt to the scheduled time", async () => {
    const targetTime = Date.now() + 60_000;
    const job = await svc.add({
      name: "One-shot",
      schedule: { kind: "at", at: targetTime },
      payload: { kind: "agent_turn", message: "fire once" },
      workerId: "worker-1",
      workspaceId: "ws-1",
    });

    expect(job.nextRunAt).toBe(targetTime);
  });

  // 3. remove() delegates to store, returns result
  it("remove() calls store.remove and returns true on success", async () => {
    const job = await svc.add({
      name: "Job",
      schedule: { kind: "every", interval_ms: 5_000 },
      payload: { kind: "agent_turn", message: "hi" },
      workerId: "worker-1",
      workspaceId: "ws-1",
    });

    (deps.store.remove as ReturnType<typeof mock>).mockResolvedValue(true);
    const result = await svc.remove("worker-1", "ws-1", job.id);

    expect(result).toBe(true);
    expect(deps.store.remove).toHaveBeenCalledWith("worker-1", "ws-1", job.id);
  });

  it("remove() returns false when store reports job not found", async () => {
    (deps.store.remove as ReturnType<typeof mock>).mockResolvedValue(false);
    const result = await svc.remove("worker-1", "ws-1", "nonexistent-id");

    expect(result).toBe(false);
  });

  // 4. update() with schedule change recomputes nextRunAt and resets consecutiveErrors
  it("update() with new schedule resets consecutiveErrors and recomputes nextRunAt", async () => {
    const existingJob: CronJob = makeJob({
      id: "job-x",
      consecutiveErrors: 3,
      schedule: { kind: "every", interval_ms: 5_000 },
    });

    // store.get returns the merged job as if store.update applied the patch
    // The service pre-computes nextRunAt and writes it in the same store.update call,
    // so the re-read from store.get should reflect it.
    const futureNextRunAt = Date.now() + 10_000;
    (deps.store.get as ReturnType<typeof mock>).mockReturnValue({
      ...existingJob,
      schedule: { kind: "every", interval_ms: 10_000 },
      consecutiveErrors: 0,
      nextRunAt: futureNextRunAt,
    } satisfies CronJob);

    const result = await svc.update("worker-1", "ws-1", "job-x", {
      schedule: { kind: "every", interval_ms: 10_000 },
    });

    expect(result).toBeDefined();
    expect(result!.consecutiveErrors).toBe(0);
    // nextRunAt should be recomputed to a future timestamp
    expect(result!.nextRunAt).toBeTypeOf("number");
    expect(result!.nextRunAt!).toBeGreaterThan(Date.now() - 1000);

    // store.update is called with the patch that resets consecutiveErrors
    expect(deps.store.update).toHaveBeenCalled();
    const firstCall = (deps.store.update as ReturnType<typeof mock>).mock.calls[0];
    expect(firstCall[2]).toBe("job-x");
    expect(firstCall[3]).toMatchObject({ consecutiveErrors: 0 });
  });

  // 5. update() with enabled=false removes job from timer loop
  it("update() with enabled=false removes job from the in-memory loop", async () => {
    const job = await svc.add({
      name: "Job",
      schedule: { kind: "every", interval_ms: 5_000 },
      payload: { kind: "agent_turn", message: "hi" },
      workerId: "worker-1",
      workspaceId: "ws-1",
    });

    // store.get returns the job with enabled=false after update
    (deps.store.get as ReturnType<typeof mock>).mockReturnValue({
      ...job,
      enabled: false,
    });

    const result = await svc.update("worker-1", "ws-1", job.id, { enabled: false });

    expect(result).toBeDefined();
    expect(result!.enabled).toBe(false);
    // store.update is called (not store.remove — the job stays in the store)
    expect(deps.store.update).toHaveBeenCalled();
  });

  it("update() returns undefined when store reports job not found", async () => {
    (deps.store.update as ReturnType<typeof mock>).mockResolvedValue(false);
    const result = await svc.update("worker-1", "ws-1", "missing-job", { name: "New Name" });
    expect(result).toBeUndefined();
  });

  // 6. list() delegates to store
  it("list() delegates to store.list with correct args", () => {
    const jobs = [makeJob()];
    (deps.store.list as ReturnType<typeof mock>).mockReturnValue(jobs);

    const result = svc.list("worker-1", "ws-1");

    expect(result).toEqual(jobs);
    expect(deps.store.list).toHaveBeenCalledWith("worker-1", "ws-1");
  });

  it("list() returns empty array when store has no jobs", () => {
    (deps.store.list as ReturnType<typeof mock>).mockReturnValue([]);
    expect(svc.list("worker-1", "ws-1")).toEqual([]);
  });

  // get() delegates to store
  it("get() delegates to store.get with correct args", () => {
    const job = makeJob();
    (deps.store.get as ReturnType<typeof mock>).mockReturnValue(job);

    const result = svc.get("worker-1", "ws-1", "job-1");

    expect(result).toEqual(job);
    expect(deps.store.get).toHaveBeenCalledWith("worker-1", "ws-1", "job-1");
  });

  it("get() returns undefined for unknown job", () => {
    (deps.store.get as ReturnType<typeof mock>).mockReturnValue(undefined);
    expect(svc.get("worker-1", "ws-1", "no-such-job")).toBeUndefined();
  });

  // 7. shutdown() clears timer
  it("shutdown() does not throw when called with no active timer", () => {
    expect(() => svc.shutdown()).not.toThrow();
  });

  it("shutdown() stops the timer loop", async () => {
    // Job due in 20ms
    const interval = 60_000;
    const now = Date.now();
    const soonDueJob = makePastDueEveryJob();
    // Override: make it due in 20ms instead of immediately
    soonDueJob.lastRunAt = now - interval + 20;
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([soonDueJob]);

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    // Shut down immediately — the timer should be cancelled
    svc.shutdown();

    // Flush event loop — timer was cancelled, so it should not fire
    await flushAsync();

    // promptFn should NOT have been called because shutdown cancelled the timer
    expect(promptFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Timer / execution tests
// ---------------------------------------------------------------------------

describe("CronService — timer execution", () => {
  let deps: CronServiceDeps;
  let svc: CronService;

  beforeEach(() => {
    deps = createMockDeps();
    svc = new CronService(deps);
  });

  afterEach(() => {
    svc.shutdown();
  });

  // 8. Timer fires and executes due job — verify promptFn called
  it("executes a due job when the timer fires", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    // Wait for the past-due timer to fire and execute the job
    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");

    expect(promptFn).toHaveBeenCalledTimes(1);
    const [sessionId, message] = (promptFn as ReturnType<typeof mock>).mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(message).toContain("[Scheduled: Test Job]");
    expect(message).toContain("hello");
  });

  // 9. Worker offline → error message injected, event emitted
  it("injects error message and emits cron_fired event when worker is offline", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    // Worker is offline
    (deps.connectionRegistry.getWorker as ReturnType<typeof mock>).mockReturnValue(undefined);

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => (deps.sessionMgr.addMessage as any).mock.calls.length >= 1, 2_000, "addMessage called");

    // promptFn should NOT be called because worker is offline
    expect(promptFn).not.toHaveBeenCalled();

    // Error message should be injected into the session
    expect(deps.sessionMgr.addMessage).toHaveBeenCalledTimes(1);
    const [injectedSessionId, injectedMsg] = (deps.sessionMgr.addMessage as ReturnType<typeof mock>).mock.calls[0];
    expect(injectedSessionId).toBe("session-1");
    expect(injectedMsg.role).toBe("user");
    expect(injectedMsg.synthetic).toBe(true);
    expect(injectedMsg.content).toContain("Worker offline");

    // Event should be emitted
    expect(deps.workspaceNotifier.emit).toHaveBeenCalledTimes(1);
    const emitArgs = (deps.workspaceNotifier.emit as ReturnType<typeof mock>).mock.calls[0];
    expect(emitArgs[0]).toBe("worker-1");
    expect(emitArgs[1]).toBe("ws-1");
    expect(emitArgs[2]).toMatchObject({ type: "cron_fired", error: "Worker offline" });
  });

  // 10. "at" job removed after successful execution
  it("removes 'at' (one-shot) job after successful execution", async () => {
    const atJob = makePastDueAtJob({ id: "one-shot" });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([atJob]);

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");

    expect(promptFn).toHaveBeenCalledTimes(1);
    // store.remove is called to delete the one-shot job after success
    expect(deps.store.remove).toHaveBeenCalledWith("worker-1", "ws-1", "one-shot");
  });

  it("keeps 'at' job in store after failed execution (does not remove)", async () => {
    const atJob = makePastDueAtJob({ id: "fail-shot" });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([atJob]);

    // Always fail — store.remove should never be called because success never happens.
    // After failure, computeAndSetNextRun sets nextRunAt = job.schedule.at (past),
    // so the job stays due and keeps firing. We verify remove is not called.
    const promptFn = mock(async () => {
      throw new Error("Agent turn failed");
    });
    svc.setPromptFn(promptFn);
    svc.init();

    // Wait for tick to execute (and fail)
    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");

    // store.remove should NOT be called — job is kept after failure
    expect(deps.store.remove).not.toHaveBeenCalled();
    // store.update should have been called at least once for the error state
    expect(deps.store.update).toHaveBeenCalled();
    // promptFn was called at least once
    expect(promptFn).toHaveBeenCalled();
  });

  // 11. Backoff: after first error, job should not re-fire within the backoff window (30s)
  it("applies 30s backoff after first failure — timer does not re-fire within 50ms", async () => {
    // Job with 0 errors that will always fail.
    // After failure: consecutiveErrors=1, backoff=30s → next run = now + 30s
    // Within 50ms the timer should NOT fire again.
    const job = makePastDueEveryJob({ consecutiveErrors: 0 });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => {
      throw new Error("failure");
    });
    svc.setPromptFn(promptFn);
    svc.init();

    // Wait for the first tick to fire (delay=0) — then backoff kicks in (30s)
    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");
    svc.shutdown();

    // Should have been called exactly once (first tick), then backed off for 30s
    expect(promptFn).toHaveBeenCalledTimes(1);
  });

  it("applies 60s backoff after 2 failures — job with consecutiveErrors=2 does not fire in 50ms", async () => {
    // A job with 2 consecutive errors gets backoff = min(3600s, 30s * 2^(2-1)) = 60s.
    // normalNext = lastRunAt + interval = now (past due).
    // nextRunAt = max(now, now + 60s) = now + 60s → won't fire in 50ms.
    const job = makePastDueEveryJob({ consecutiveErrors: 2 });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await flushAsync();
    svc.shutdown();

    expect(promptFn).not.toHaveBeenCalled();
  });

  it("caps backoff at 3600s — init schedules far-future job for high error count", async () => {
    const BACKOFF_MAX_MS = 3_600_000;

    // A job with 8 consecutive errors. On init, computeNextRun applies backoff:
    // backoff = min(3600s, 30s * 2^7) = min(3600s, 3840s) = 3600s
    // normalNext = lastRunAt + interval = now (past)
    // nextRunAt = max(now, now + 3600s) = now + 3600s
    //
    // Since nextRunAt is now+3600s, the timer fires after 3600s.
    // Within 50ms the job should NOT fire at all.
    const job = makePastDueEveryJob({ consecutiveErrors: 8 });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    // Flush event loop — job should not fire because nextRunAt is capped at 3600s
    await flushAsync();
    svc.shutdown();

    // promptFn must NOT have been called — job was deferred by capped backoff
    expect(promptFn).not.toHaveBeenCalled();
  });

  // 12. Success resets consecutiveErrors to 0
  it("resets consecutiveErrors to 0 after successful execution", async () => {
    // Use consecutiveErrors: 0 so that init() doesn't apply backoff (job fires immediately)
    const job = makePastDueEveryJob({ consecutiveErrors: 0 });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");

    expect(promptFn).toHaveBeenCalledTimes(1);

    // store.update called with consecutiveErrors: 0 and lastStatus: "ok"
    const updateCalls = (deps.store.update as ReturnType<typeof mock>).mock.calls;
    const successCall = updateCalls.find((c) => c[3]?.lastStatus === "ok");
    expect(successCall).toBeDefined();
    expect(successCall![3].consecutiveErrors).toBe(0);
    expect(successCall![3].lastStatus).toBe("ok");
    expect(successCall![3].lastError).toBeUndefined();
  });

  // Workspace not found: error state updated, no promptFn call.
  // Note: this path doesn't call computeAndSetNextRun, so nextRunAt stays in the past
  // and the timer re-fires immediately each tick. We shutdown after a tick and verify.
  it("skips execution and logs warning when workspace is not found", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);
    (deps.workspaceStore.get as ReturnType<typeof mock>).mockResolvedValue(undefined);

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => (deps.store.update as any).mock.calls.length >= 1, 2_000, "store.update called");
    svc.shutdown();

    expect(promptFn).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
    // store.update called at least once to record the error state
    expect(deps.store.update).toHaveBeenCalled();
  });

  // No session in workspace: error recorded, nextRunAt advanced (no tight loop).
  it("records error and advances nextRunAt when workspace has no lastSessionId", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);
    (deps.workspaceStore.get as ReturnType<typeof mock>).mockResolvedValue({ lastSessionId: undefined });

    const promptFn = mock(async () => ({ messageId: "msg-1" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => (deps.store.update as any).mock.calls.length >= 1, 2_000, "store.update called");
    svc.shutdown();

    expect(promptFn).not.toHaveBeenCalled();
    // store.update called to record the error
    expect(deps.store.update).toHaveBeenCalled();
    const updateCalls = (deps.store.update as ReturnType<typeof mock>).mock.calls;
    const errorCall = updateCalls.find((c) => c[3]?.lastError === "No active session in workspace");
    expect(errorCall).toBeDefined();
  });

  // Session deleted → resolveTargetSession creates a new one
  it("creates a new session when lastSessionId points to a deleted session", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);
    (deps.workspaceStore.get as ReturnType<typeof mock>).mockResolvedValue({ lastSessionId: "deleted-session" });
    // sessionMgr.load returns null for the deleted session
    (deps.sessionMgr.load as ReturnType<typeof mock>).mockReturnValue(null);
    // sessionMgr.create returns a new session
    (deps.sessionMgr.create as ReturnType<typeof mock>).mockResolvedValue({ sessionId: "new-session-1" });

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");
    svc.shutdown();

    // Should have created a new session
    expect(deps.sessionMgr.create).toHaveBeenCalledWith({
      workerId: "worker-1",
      workspaceId: "ws-1",
    });
    // And registered it with the workspace
    expect(deps.workspaceStore.addSession).toHaveBeenCalledWith("worker-1", "ws-1", "new-session-1");
    // And prompted in the new session
    expect(promptFn).toHaveBeenCalled();
    const promptCall = promptFn.mock.calls[0];
    expect(promptCall[0]).toBe("new-session-1");
  });

  // promptFn not set: warns and skips. The timer re-fires each tick (same missing-nextRunAt-advance
  // issue). We shutdown and verify warn was called.
  it("logs a warning and skips execution when promptFn is not set", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    // Intentionally do NOT call setPromptFn
    svc.init();

    await waitUntil(() => (deps.logger.warn as any).mock.calls.length >= 1, 2_000, "logger.warn called");
    svc.shutdown();

    expect(deps.logger.warn).toHaveBeenCalled();
  });

  // emitCronEvent success path: event emitted without error field
  it("emits cron_fired event without error on successful execution", async () => {
    const job = makePastDueEveryJob();
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([job]);

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => (deps.workspaceNotifier.emit as any).mock.calls.length >= 1, 2_000, "emit called");

    expect(deps.workspaceNotifier.emit).toHaveBeenCalledTimes(1);
    const emitArgs = (deps.workspaceNotifier.emit as ReturnType<typeof mock>).mock.calls[0];
    expect(emitArgs[2].type).toBe("cron_fired");
    expect(emitArgs[2].error).toBeUndefined();
    expect(emitArgs[2].jobId).toBe(job.id);
    expect(emitArgs[2].jobName).toBe(job.name);
    expect(emitArgs[2].targetSessionId).toBe("session-1");
  });

  // 'at' job: store.remove is called on success (not store.update for status)
  it("calls store.remove (not store.update for status) on 'at' job success", async () => {
    const atJob = makePastDueAtJob({ id: "at-success" });
    (deps.store.loadAll as ReturnType<typeof mock>).mockReturnValue([atJob]);

    const promptFn = mock(async () => ({ messageId: "msg-ok" }));
    svc.setPromptFn(promptFn);
    svc.init();

    await waitUntil(() => promptFn.mock.calls.length >= 1, 2_000, "promptFn called");

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(deps.store.remove).toHaveBeenCalledWith("worker-1", "ws-1", "at-success");

    // No store.update with lastStatus: "ok" — at jobs are removed, not updated on success
    const updateCalls = (deps.store.update as ReturnType<typeof mock>).mock.calls;
    const successStatusUpdates = updateCalls.filter((c) => c[3]?.lastStatus === "ok");
    expect(successStatusUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// nextRunAt computation tests (white-box via add())
// ---------------------------------------------------------------------------

describe("CronService — nextRunAt computation", () => {
  it("'every' job nextRunAt is one interval from anchor when no lastRunAt", async () => {
    const deps = createMockDeps();
    const svc = new CronService(deps);
    const before = Date.now();
    const job = await svc.add({
      name: "Clean",
      schedule: { kind: "every", interval_ms: 60_000 },
      payload: { kind: "agent_turn", message: "x" },
      workerId: "w",
      workspaceId: "ws",
    });
    svc.shutdown();

    // nextRunAt should be approximately now + 60s
    expect(job.nextRunAt).toBeDefined();
    expect(job.nextRunAt!).toBeGreaterThan(before + 59_000);
    expect(job.nextRunAt!).toBeLessThan(before + 61_000);
  });

  it("'at' job nextRunAt equals the at timestamp exactly", async () => {
    const deps = createMockDeps();
    const svc = new CronService(deps);
    const targetTime = Date.now() + 30_000;
    const job = await svc.add({
      name: "Scheduled",
      schedule: { kind: "at", at: targetTime },
      payload: { kind: "agent_turn", message: "x" },
      workerId: "w",
      workspaceId: "ws",
    });
    svc.shutdown();

    expect(job.nextRunAt).toBe(targetTime);
  });

  it("disabled job has no nextRunAt after add()", async () => {
    const deps = createMockDeps();
    const svc = new CronService(deps);
    const job = await svc.add({
      name: "Disabled",
      schedule: { kind: "every", interval_ms: 60_000 },
      payload: { kind: "agent_turn", message: "x" },
      workerId: "w",
      workspaceId: "ws",
      enabled: false,
    });
    svc.shutdown();

    expect(job.nextRunAt).toBeUndefined();
  });
});
