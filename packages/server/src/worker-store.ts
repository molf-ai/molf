import { getLogger } from "@logtape/logtape";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { rename, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { KnownWorker } from "./connection-registry.js";

const logger = getLogger(["molf", "server", "worker-store"]);

/**
 * Persists KnownWorker state to `data/workers/{id}/state.json`.
 * Each worker gets its own directory to allow future per-worker files
 * (e.g., `permissions.jsonc` for the tool approval system).
 */
export class WorkerStore {
  private readonly workersDir: string;

  constructor(dataDir: string) {
    this.workersDir = resolve(dataDir, "workers");
    mkdirSync(this.workersDir, { recursive: true });
  }

  /** Synchronously loads all persisted workers, each marked `online: false`. */
  loadAll(): KnownWorker[] {
    const workers: KnownWorker[] = [];

    let entries: string[];
    try {
      entries = readdirSync(this.workersDir);
    } catch {
      return workers;
    }

    for (const entry of entries) {
      const stateFile = resolve(this.workersDir, entry, "state.json");
      try {
        const raw = readFileSync(stateFile, "utf-8");
        const data = JSON.parse(raw);
        workers.push({
          id: data.id,
          name: data.name,
          online: false,
          connectedAt: data.connectedAt,
          lastSeenAt: data.lastSeenAt,
          tools: data.tools ?? [],
          skills: data.skills ?? [],
          agents: data.agents ?? [],
          metadata: data.metadata,
        });
      } catch {
        logger.warn("Skipping corrupt worker state file: {path}", { path: stateFile });
      }
    }

    return workers;
  }

  /** Atomically persists a worker's state. Strips `online` field. */
  async save(worker: KnownWorker): Promise<void> {
    const workerDir = resolve(this.workersDir, worker.id);
    await mkdir(workerDir, { recursive: true });

    const filePath = resolve(workerDir, "state.json");
    const tmpPath = `${filePath}.tmp`;

    const { online: _, ...persisted } = worker;
    await writeFile(tmpPath, JSON.stringify(persisted, null, 2));
    await rename(tmpPath, filePath);
  }

  /** Removes a worker's directory and all its files. */
  async delete(workerId: string): Promise<void> {
    const workerDir = resolve(this.workersDir, workerId);
    rmSync(workerDir, { recursive: true, force: true });
  }
}
