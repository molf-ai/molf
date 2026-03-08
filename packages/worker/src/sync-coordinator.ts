import type { WorkerToolInfo, WorkerSkillInfo, WorkerAgentInfo, WorkerMetadata } from "@molf-ai/protocol";

export interface SyncSources {
  tools: () => WorkerToolInfo[];
  skills: () => WorkerSkillInfo[];
  agents: () => WorkerAgentInfo[];
  metadata: () => WorkerMetadata | undefined;
}

export interface SyncTarget {
  syncState(state: {
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    agents: WorkerAgentInfo[];
    metadata?: WorkerMetadata;
  }): Promise<void>;
}

/**
 * Single serialization queue for all state sync calls.
 * Both StateWatcher and plugins call requestSync() to signal "something changed."
 * State is read from canonical source getters at send time — always fresh.
 */
export class SyncCoordinator {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private sources: SyncSources,
    private target: SyncTarget,
  ) {}

  requestSync(): void {
    this.pending = this.pending.then(() => this.doSync(), () => this.doSync());
  }

  /** Await pending syncs (for testing). */
  flush(): Promise<void> {
    return this.pending;
  }

  private async doSync(): Promise<void> {
    const state = {
      tools: this.sources.tools(),
      skills: this.sources.skills(),
      agents: this.sources.agents(),
      metadata: this.sources.metadata(),
    };
    await this.target.syncState(state);
  }
}
