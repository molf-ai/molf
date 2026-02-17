import type { ConnectionEntry, WorkerMetadata } from "@molf-ai/protocol";
import type { WorkerToolInfo, WorkerSkillInfo } from "@molf-ai/protocol";

export interface WorkerRegistration extends ConnectionEntry {
  role: "worker";
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

  registerWorker(entry: Omit<WorkerRegistration, "role">): void {
    if (this.connections.has(entry.id)) {
      throw new Error(`Connection with id ${entry.id} already exists`);
    }
    this.connections.set(entry.id, { ...entry, role: "worker" });
  }

  registerClient(entry: Omit<ClientRegistration, "role">): void {
    this.connections.set(entry.id, { ...entry, role: "client" });
  }

  unregister(id: string): void {
    this.connections.delete(id);
  }

  get(id: string): Registration | undefined {
    return this.connections.get(id);
  }

  getWorker(id: string): WorkerRegistration | undefined {
    const entry = this.connections.get(id);
    return entry?.role === "worker" ? entry : undefined;
  }

  getWorkers(): WorkerRegistration[] {
    return Array.from(this.connections.values()).filter(
      (e): e is WorkerRegistration => e.role === "worker",
    );
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
