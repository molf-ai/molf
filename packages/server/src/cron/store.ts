import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { CronJob } from "@molf-ai/protocol";

const log = getLogger(["molf", "cron-store"]);

export class CronStore {
  /** In-memory cache: Map<"workerId:workspaceId", CronJob[]> */
  private cache = new Map<string, CronJob[]>();

  constructor(private dataDir: string) {}

  private key(workerId: string, workspaceId: string): string {
    return `${workerId}:${workspaceId}`;
  }

  /** Path: data/workers/{workerId}/workspaces/{workspaceId}/cron/jobs.json */
  private jobsPath(workerId: string, workspaceId: string): string {
    return join(this.dataDir, "workers", workerId, "workspaces", workspaceId, "cron", "jobs.json");
  }

  private cronDir(workerId: string, workspaceId: string): string {
    return join(this.dataDir, "workers", workerId, "workspaces", workspaceId, "cron");
  }

  /** Load jobs for a specific workspace (lazy, cached). */
  load(workerId: string, workspaceId: string): CronJob[] {
    const k = this.key(workerId, workspaceId);
    if (this.cache.has(k)) return this.cache.get(k)!;

    let jobs: CronJob[] = [];
    try {
      const raw = readFileSync(this.jobsPath(workerId, workspaceId), "utf-8");
      jobs = JSON.parse(raw);
    } catch {
      // No jobs file yet — that's fine
    }

    this.cache.set(k, jobs);
    return jobs;
  }

  /** Scan all workspaces for cron jobs. Used on startup. */
  loadAll(): CronJob[] {
    const all: CronJob[] = [];
    const workersDir = join(this.dataDir, "workers");

    let workerEntries: Dirent[];
    try {
      workerEntries = readdirSync(workersDir, { withFileTypes: true });
    } catch {
      return all;
    }

    for (const workerEntry of workerEntries) {
      if (!workerEntry.isDirectory()) continue;
      const workspacesDir = join(workersDir, workerEntry.name, "workspaces");

      let wsEntries: Dirent[];
      try {
        wsEntries = readdirSync(workspacesDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const wsEntry of wsEntries) {
        if (!wsEntry.isDirectory()) continue;
        const jobs = this.load(workerEntry.name, wsEntry.name);
        all.push(...jobs);
      }
    }

    return all;
  }

  /** Atomic write: write tmp + rename. */
  async save(workerId: string, workspaceId: string): Promise<void> {
    const k = this.key(workerId, workspaceId);
    const jobs = this.cache.get(k);
    if (!jobs) return;

    const dir = this.cronDir(workerId, workspaceId);
    await mkdir(dir, { recursive: true });

    const filePath = this.jobsPath(workerId, workspaceId);
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(jobs, null, 2));
    await rename(tmpPath, filePath);
  }

  async add(job: CronJob): Promise<void> {
    const jobs = this.load(job.workerId, job.workspaceId);
    jobs.push(job);
    await this.save(job.workerId, job.workspaceId);
  }

  async remove(workerId: string, workspaceId: string, jobId: string): Promise<boolean> {
    const jobs = this.load(workerId, workspaceId);
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    await this.save(workerId, workspaceId);
    return true;
  }

  async update(workerId: string, workspaceId: string, jobId: string, patch: Partial<CronJob>): Promise<boolean> {
    const jobs = this.load(workerId, workspaceId);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return false;
    Object.assign(job, patch);
    await this.save(workerId, workspaceId);
    return true;
  }

  get(workerId: string, workspaceId: string, jobId: string): CronJob | undefined {
    const jobs = this.load(workerId, workspaceId);
    return jobs.find((j) => j.id === jobId);
  }

  list(workerId: string, workspaceId: string): CronJob[] {
    return this.load(workerId, workspaceId);
  }
}
