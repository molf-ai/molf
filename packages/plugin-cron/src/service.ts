import { randomUUID } from "node:crypto";
import { getLogger } from "@logtape/logtape";
import type {
  CronSchedule, CronPayload, SessionMessage, CronJob,
  ServerPluginApi,
} from "@molf-ai/protocol";
import type { CronStore } from "./store.js";
import type { PromptFn } from "./types.js";
import { AgentBusyError } from "./types.js";
import { nextCronRun } from "./time.js";

const MAX_TIMER_DELAY_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
const BUSY_RETRY_MS = 5_000;

const logger = getLogger(["molf", "plugin", "cron"]);

export class CronService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private promptFn: PromptFn | null = null;
  private jobs = new Map<string, CronJob>();

  constructor(
    private readonly api: ServerPluginApi,
    private readonly store: CronStore,
  ) {}

  setPromptFn(fn: PromptFn): void {
    this.promptFn = fn;
  }

  init(): void {
    const allJobs = this.store.loadAll();
    const now = Date.now();

    for (const job of allJobs) {
      if (!job.enabled) continue;
      job.nextRunAt = this.computeNextRun(job, now);
      this.jobs.set(job.id, job);
    }

    logger.info(`Cron initialized with ${this.jobs.size} enabled jobs`);
    this.reschedule();
  }

  shutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async add(params: {
    name: string;
    schedule: CronSchedule;
    payload: CronPayload;
    workerId: string;
    workspaceId: string;
    enabled?: boolean;
  }): Promise<CronJob> {
    const now = Date.now();
    const job: CronJob = {
      id: randomUUID(),
      name: params.name,
      enabled: params.enabled ?? true,
      schedule: params.schedule,
      payload: params.payload,
      workerId: params.workerId,
      workspaceId: params.workspaceId,
      createdAt: now,
      updatedAt: now,
      consecutiveErrors: 0,
    };

    if (job.enabled) {
      job.nextRunAt = this.computeNextRun(job, now);
    }

    await this.store.add(job);

    if (job.enabled) {
      this.jobs.set(job.id, job);
      this.reschedule();
    }

    return job;
  }

  async remove(workerId: string, workspaceId: string, jobId: string): Promise<boolean> {
    const removed = await this.store.remove(workerId, workspaceId, jobId);
    if (removed) {
      this.jobs.delete(jobId);
      this.reschedule();
    }
    return removed;
  }

  async update(
    workerId: string,
    workspaceId: string,
    jobId: string,
    patch: { enabled?: boolean; schedule?: CronSchedule; payload?: CronPayload; name?: string },
  ): Promise<CronJob | undefined> {
    const now = Date.now();
    const storePatch: Partial<CronJob> = { updatedAt: now };

    if (patch.name !== undefined) storePatch.name = patch.name;
    if (patch.payload !== undefined) storePatch.payload = patch.payload;
    if (patch.enabled !== undefined) storePatch.enabled = patch.enabled;
    if (patch.schedule !== undefined) {
      storePatch.schedule = patch.schedule;
      storePatch.consecutiveErrors = 0;
    }

    const currentJob = this.store.get(workerId, workspaceId, jobId);
    if (!currentJob) return undefined;

    const willBeEnabled = patch.enabled ?? currentJob.enabled;
    if (willBeEnabled) {
      const merged = { ...currentJob, ...storePatch };
      storePatch.nextRunAt = this.computeNextRun(merged as CronJob, now);
    }

    const updated = await this.store.update(workerId, workspaceId, jobId, storePatch);
    if (!updated) return undefined;

    const job = this.store.get(workerId, workspaceId, jobId);
    if (!job) return undefined;

    if (job.enabled) {
      this.jobs.set(job.id, job);
    } else {
      this.jobs.delete(jobId);
    }

    this.reschedule();
    return job;
  }

  list(workerId: string, workspaceId: string): CronJob[] {
    return this.store.list(workerId, workspaceId);
  }

  get(workerId: string, workspaceId: string, jobId: string): CronJob | undefined {
    return this.store.get(workerId, workspaceId, jobId);
  }

  // --- Timer loop ---

  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.jobs.size === 0) return;

    let earliest = Infinity;
    for (const job of this.jobs.values()) {
      if (job.nextRunAt !== undefined && job.nextRunAt < earliest) {
        earliest = job.nextRunAt;
      }
    }

    if (earliest === Infinity) return;

    const delay = Math.max(0, Math.min(earliest - Date.now(), MAX_TIMER_DELAY_MS));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const now = Date.now();

    const dueJobs: CronJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.nextRunAt !== undefined && job.nextRunAt <= now) {
        dueJobs.push(job);
      }
    }

    for (const job of dueJobs) {
      try {
        await this.executeJob(job);
      } catch (err) {
        logger.error(`Unexpected error executing cron job ${job.name}: ${err}`);
      }
    }

    this.reschedule();
  }

  private async executeJob(job: CronJob): Promise<void> {
    if (!this.promptFn) {
      logger.warn(`CronService: promptFn not set, skipping job ${job.name}`);
      return;
    }

    const workspace = await this.api.workspaceStore.get(job.workerId, job.workspaceId);
    if (!workspace) {
      logger.warn(`CronService: workspace not found for job ${job.name}`);
      await this.updateJobError(job, "Workspace not found");
      this.computeAndSetNextRun(job);
      return;
    }

    const targetSessionId = await this.resolveTargetSession(job, workspace);
    if (!targetSessionId) {
      await this.updateJobError(job, "No active session in workspace");
      this.computeAndSetNextRun(job);
      return;
    }

    const worker = this.api.connectionRegistry.getWorker(job.workerId);
    if (!worker) {
      await this.injectErrorMessage(targetSessionId, job, "Worker offline");
      this.emitCronEvent(job, targetSessionId, "Worker offline");
      await this.updateJobError(job, "Worker offline");
      this.computeAndSetNextRun(job);
      return;
    }

    const message = `[Scheduled: ${job.name}] ${job.payload.message}`;
    logger.info(`Cron job "${job.name}" firing`, { jobId: job.id, sessionId: targetSessionId });

    try {
      await this.promptFn(targetSessionId, message, { synthetic: true });

      job.lastRunAt = Date.now();
      job.lastStatus = "ok";
      job.lastError = undefined;
      job.consecutiveErrors = 0;

      this.emitCronEvent(job, targetSessionId);

      if (job.schedule.kind === "at") {
        await this.store.remove(job.workerId, job.workspaceId, job.id);
        this.jobs.delete(job.id);
      } else {
        this.computeAndSetNextRun(job);
        await this.store.update(job.workerId, job.workspaceId, job.id, {
          lastRunAt: job.lastRunAt,
          lastStatus: job.lastStatus,
          lastError: job.lastError,
          consecutiveErrors: job.consecutiveErrors,
          nextRunAt: job.nextRunAt,
        });
      }
    } catch (err) {
      if (err instanceof AgentBusyError || (err instanceof Error && err.name === "AgentBusyError")) {
        job.nextRunAt = Date.now() + BUSY_RETRY_MS;
        return;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      job.consecutiveErrors++;
      await this.updateJobError(job, errorMsg);
      this.computeAndSetNextRun(job);
      this.emitCronEvent(job, targetSessionId, errorMsg);
    }
  }

  private async resolveTargetSession(
    job: CronJob,
    workspace: { lastSessionId: string },
  ): Promise<string | null> {
    const sessionId = workspace.lastSessionId;
    if (!sessionId) return null;

    const session = this.api.sessionMgr.load(sessionId);
    if (session) return sessionId;

    const newSession = await this.api.sessionMgr.create({
      workerId: job.workerId,
      workspaceId: job.workspaceId,
    });
    await this.api.workspaceStore.addSession(job.workerId, job.workspaceId, newSession.sessionId);
    return newSession.sessionId;
  }

  private async injectErrorMessage(sessionId: string, job: CronJob, error: string): Promise<void> {
    const msg: SessionMessage = {
      id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
      role: "user",
      content: `[Scheduled: "${job.name}" — failed: ${error}]`,
      timestamp: Date.now(),
      synthetic: true,
    };
    this.api.sessionMgr.addMessage(sessionId, msg);
    await this.api.sessionMgr.save(sessionId);
  }

  private emitCronEvent(job: CronJob, targetSessionId: string, error?: string): void {
    this.api.workspaceNotifier.emit(job.workerId, job.workspaceId, {
      type: "cron_fired",
      jobId: job.id,
      jobName: job.name,
      targetSessionId,
      message: job.payload.message,
      ...(error ? { error } : {}),
    });
  }

  private async updateJobError(job: CronJob, error: string): Promise<void> {
    job.lastRunAt = Date.now();
    job.lastStatus = "error";
    job.lastError = error;
    await this.store.update(job.workerId, job.workspaceId, job.id, {
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
      lastError: job.lastError,
      consecutiveErrors: job.consecutiveErrors,
      nextRunAt: job.nextRunAt,
    });
  }

  private computeAndSetNextRun(job: CronJob): void {
    job.nextRunAt = this.computeNextRun(job, Date.now());
    if (job.nextRunAt === undefined) {
      this.jobs.delete(job.id);
    }
  }

  private computeNextRun(job: CronJob, now: number): number | undefined {
    const normalNext = this.computeNormalNextRun(job, now);
    if (normalNext === undefined) return undefined;

    if (job.consecutiveErrors === 0) return normalNext;
    if (job.schedule.kind === "at") return normalNext;

    const backoff = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * Math.pow(2, job.consecutiveErrors - 1),
    );
    return Math.max(normalNext, now + backoff);
  }

  private computeNormalNextRun(job: CronJob, now: number): number | undefined {
    switch (job.schedule.kind) {
      case "at":
        return job.schedule.at;

      case "every": {
        const anchor = job.schedule.anchor_ms ?? job.createdAt;
        const interval = job.schedule.interval_ms;
        if (job.lastRunAt) {
          return job.lastRunAt + interval;
        }
        const elapsed = now - anchor;
        const periods = Math.floor(elapsed / interval);
        return anchor + (periods + 1) * interval;
      }

      case "cron": {
        const next = nextCronRun(job.schedule.expr, job.schedule.tz);
        return next ?? undefined;
      }
    }
  }
}
