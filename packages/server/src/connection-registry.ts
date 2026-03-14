import { getLogger } from "@logtape/logtape";
import type {
  WorkerToolInfo, WorkerSkillInfo, WorkerAgentInfo, WorkerMetadata,
  WorkerRegistration, KnownWorker, ClientRegistration, Registration,
  IConnectionRegistry,
} from "@molf-ai/protocol";
import type { HookRegistry } from "@molf-ai/protocol";
import type { WorkerStore } from "./worker-store.js";

export type { WorkerRegistration, KnownWorker, ClientRegistration, Registration };

const logger = getLogger(["molf", "server", "conn-registry"]);

export class ConnectionRegistry implements IConnectionRegistry {
  private connections = new Map<string, Registration>();
  /**
   * All workers that have ever connected. On disconnect, marked offline.
   * On re-register, overwritten with fresh state.
   * This is the single source of truth for worker state — `connections`
   * map only tracks live connection presence.
   */
  private knownWorkers = new Map<string, KnownWorker>();
  private hookRegistry?: HookRegistry;

  constructor(private workerStore?: WorkerStore) {}

  /** Set hook registry for plugin dispatches. */
  setHookRegistry(registry: HookRegistry): void {
    this.hookRegistry = registry;
  }

  /** Load persisted workers from disk into knownWorkers. All start offline. */
  init(): void {
    if (!this.workerStore) return;
    const workers = this.workerStore.loadAll();
    for (const w of workers) {
      this.knownWorkers.set(w.id, w);
    }
  }

  registerWorker(entry: Omit<WorkerRegistration, "role">): void {
    if (this.connections.has(entry.id)) {
      throw new Error(`Connection with id ${entry.id} already exists`);
    }
    const reg: WorkerRegistration = { ...entry, role: "worker" };
    this.connections.set(entry.id, reg);

    // Single source of truth: knownWorkers holds the state,
    // the WorkerRegistration in connections shares the same arrays.
    const known: KnownWorker = {
      id: entry.id,
      name: entry.name,
      online: true,
      connectedAt: entry.connectedAt,
      lastSeenAt: Date.now(),
      tools: reg.tools,
      skills: reg.skills,
      agents: reg.agents,
      metadata: reg.metadata,
    };
    this.knownWorkers.set(entry.id, known);
    this.persistWorker(known);

    this.hookRegistry?.dispatchObserving("worker_connect", {
      workerId: entry.id,
      name: entry.name,
      tools: reg.tools,
      skills: reg.skills,
    }, { warn: (msg) => logger.warn(msg) });
  }

  registerClient(entry: Omit<ClientRegistration, "role">): void {
    this.connections.set(entry.id, { ...entry, role: "client" });
  }

  unregister(id: string): void {
    const entry = this.connections.get(id);
    this.connections.delete(id);

    // For workers, keep the entry in knownWorkers but mark offline
    if (entry?.role === "worker") {
      const known = this.knownWorkers.get(id);
      if (known) {
        known.online = false;
        known.lastSeenAt = Date.now();
        this.persistWorker(known);
      }

      this.hookRegistry?.dispatchObserving("worker_disconnect", {
        workerId: id,
        reason: "clean",
      }, { warn: (msg) => logger.warn(msg) });
    }
  }

  get(id: string): Registration | undefined {
    return this.connections.get(id);
  }

  /** Returns worker registration only if the worker is currently connected (online). */
  getWorker(id: string): WorkerRegistration | undefined {
    const entry = this.connections.get(id);
    return entry?.role === "worker" ? entry : undefined;
  }

  /** Returns all currently connected (online) workers. */
  getWorkers(): WorkerRegistration[] {
    return Array.from(this.connections.values()).filter(
      (e): e is WorkerRegistration => e.role === "worker",
    );
  }

  /** Returns all known workers (online + offline) with their last known state. */
  getKnownWorkers(): KnownWorker[] {
    return Array.from(this.knownWorkers.values());
  }

  /**
   * Update a connected worker's state (tools, skills, metadata).
   * Used by worker.syncState — replaces the full snapshot, no merge logic.
   * Returns false if the worker is not currently connected.
   */
  updateWorkerState(
    workerId: string,
    state: {
      tools: WorkerToolInfo[];
      skills: WorkerSkillInfo[];
      agents: WorkerAgentInfo[];
      metadata?: WorkerMetadata;
    },
  ): boolean {
    const entry = this.connections.get(workerId);
    if (!entry || entry.role !== "worker") return false;

    // Replace the full snapshot — the worker always sends complete state.
    entry.tools = state.tools;
    entry.skills = state.skills;
    entry.agents = state.agents;
    if (state.metadata !== undefined) {
      entry.metadata = state.metadata;
    }

    const known = this.knownWorkers.get(workerId);
    if (known) {
      known.tools = entry.tools;
      known.skills = entry.skills;
      known.agents = entry.agents;
      known.metadata = entry.metadata;
      known.lastSeenAt = Date.now();
      this.persistWorker(known);
    }

    return true;
  }

  /**
   * Rename a worker. Updates both the connection entry (if online) and
   * the knownWorkers map, then persists.
   * Returns false if the worker is unknown.
   */
  renameWorker(workerId: string, name: string): boolean {
    const known = this.knownWorkers.get(workerId);
    if (!known) return false;

    known.name = name;

    // Also update the live connection entry if present
    const entry = this.connections.get(workerId);
    if (entry?.role === "worker") {
      entry.name = name;
    }

    this.persistWorker(known);
    return true;
  }

  getClients(): ClientRegistration[] {
    return Array.from(this.connections.values()).filter(
      (e): e is ClientRegistration => e.role === "client",
    );
  }

  isConnected(id: string): boolean {
    return this.connections.has(id);
  }

  counts(): { workers: number; clients: number } {
    let workers = 0;
    let clients = 0;
    for (const entry of this.connections.values()) {
      if (entry.role === "worker") workers++;
      else clients++;
    }
    return { workers, clients };
  }

  /** Fire-and-forget persist. Logs errors but does not throw. */
  private persistWorker(worker: KnownWorker): void {
    if (!this.workerStore) return;
    this.workerStore.save(worker).catch((err) => {
      logger.error("Failed to persist worker state: {error}", {
        error: err instanceof Error ? err.message : String(err),
        workerId: worker.id,
      });
    });
  }
}
