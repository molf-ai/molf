import type { ConnectionEntry, WorkerMetadata } from "@molf-ai/protocol";
import type { WorkerToolInfo, WorkerSkillInfo } from "@molf-ai/protocol";

export interface WorkerRegistration extends ConnectionEntry {
  role: "worker";
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  metadata?: WorkerMetadata;
}

export interface KnownWorker {
  id: string;
  name: string;
  online: boolean;
  connectedAt: number;
  lastSeenAt: number;
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  metadata?: WorkerMetadata;
}

export interface ClientRegistration extends ConnectionEntry {
  role: "client";
}

export type Registration = WorkerRegistration | ClientRegistration;

export class ConnectionRegistry {
  private connections = new Map<string, Registration>();
  /**
   * All workers that have ever connected. On disconnect, marked offline.
   * On re-register, overwritten with fresh state.
   * This is the single source of truth for worker state — `connections`
   * map only tracks live connection presence.
   */
  private knownWorkers = new Map<string, KnownWorker>();

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
      metadata: reg.metadata,
    };
    this.knownWorkers.set(entry.id, known);
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
      }
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
    state: { tools: WorkerToolInfo[]; skills: WorkerSkillInfo[]; metadata?: WorkerMetadata },
  ): boolean {
    const entry = this.connections.get(workerId);
    if (!entry || entry.role !== "worker") return false;

    // Replace the full snapshot — the worker always sends complete state.
    entry.tools = state.tools;
    entry.skills = state.skills;
    if (state.metadata !== undefined) {
      entry.metadata = state.metadata;
    }

    const known = this.knownWorkers.get(workerId);
    if (known) {
      known.tools = entry.tools;
      known.skills = entry.skills;
      known.metadata = entry.metadata;
      known.lastSeenAt = Date.now();
    }

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
}
