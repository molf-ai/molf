import type { RpcClient } from "@molf-ai/protocol";

export interface SessionEntry {
  workerId: string;
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  sessionName: string;
}

/**
 * Maps Telegram chat IDs to Molf workspace + session IDs.
 * Sessions persist until the user explicitly runs /new.
 */
export class SessionMap {
  private map = new Map<number, SessionEntry>();
  private pendingCreation = new Set<number>();
  private client: RpcClient;
  private workerId: string;

  constructor(client: RpcClient, workerId: string) {
    this.client = client;
    this.workerId = workerId;
  }

  async getOrCreate(chatId: number): Promise<string> {
    const existing = this.map.get(chatId);
    if (existing) return existing.sessionId;

    this.pendingCreation.add(chatId);
    try {
      const { workspace } = await this.client.workspace.ensureDefault({
        workerId: this.workerId,
      });

      const result = await this.client.session.create({
        workerId: this.workerId,
        workspaceId: workspace.id,
        metadata: { client: "telegram", chatId },
      });
      this.map.set(chatId, {
        workerId: this.workerId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        sessionId: result.sessionId,
        sessionName: result.name,
      });
      return result.sessionId;
    } finally {
      this.pendingCreation.delete(chatId);
    }
  }

  get(chatId: number): string | undefined {
    return this.map.get(chatId)?.sessionId;
  }

  hasPendingCreation(chatId: number): boolean {
    return this.pendingCreation.has(chatId);
  }

  getEntry(chatId: number): SessionEntry | undefined {
    return this.map.get(chatId);
  }

  async createNew(chatId: number): Promise<string> {
    const entry = this.map.get(chatId);

    this.pendingCreation.add(chatId);
    try {
      let workspaceId: string;
      let workspaceName: string;

      if (entry) {
        workspaceId = entry.workspaceId;
        workspaceName = entry.workspaceName;
      } else {
        const { workspace } = await this.client.workspace.ensureDefault({
          workerId: this.workerId,
        });
        workspaceId = workspace.id;
        workspaceName = workspace.name;
      }

      const result = await this.client.session.create({
        workerId: this.workerId,
        workspaceId,
        metadata: { client: "telegram", chatId },
      });
      this.map.set(chatId, {
        workerId: this.workerId,
        workspaceId,
        workspaceName,
        sessionId: result.sessionId,
        sessionName: result.name,
      });
      return result.sessionId;
    } finally {
      this.pendingCreation.delete(chatId);
    }
  }

  has(chatId: number): boolean {
    return this.map.has(chatId);
  }

  activeChatIds(): number[] {
    return [...this.map.keys()];
  }

  chatIdsInWorkspace(workspaceId: string): number[] {
    const result: number[] = [];
    for (const [chatId, entry] of this.map) {
      if (entry.workspaceId === workspaceId) result.push(chatId);
    }
    return result;
  }

  switchWorkspace(chatId: number, workspaceId: string, workspaceName: string, sessionId: string, sessionName: string): void {
    this.map.set(chatId, {
      workerId: this.workerId,
      workspaceId,
      workspaceName,
      sessionId,
      sessionName,
    });
  }

  setWorkerId(workerId: string): void {
    this.workerId = workerId;
  }

  async restore(): Promise<number> {
    const { workspace } = await this.client.workspace.ensureDefault({
      workerId: this.workerId,
    });

    const { sessions } = await this.client.session.list({
      metadata: { client: "telegram" },
      workerId: this.workerId,
    });
    let count = 0;

    for (const session of sessions) {
      const chatId = session.metadata?.chatId;
      if (typeof chatId === "number" && !this.map.has(chatId)) {
        this.map.set(chatId, {
          workerId: this.workerId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          sessionId: session.sessionId,
          sessionName: session.name,
        });
        count++;
      }
    }

    return count;
  }

  async switchToLatest(chatId: number): Promise<{ sessionId: string; resumed: boolean }> {
    try {
      const { workspace, sessionId } = await this.client.workspace.ensureDefault({
        workerId: this.workerId,
      });

      let sessionName = sessionId.slice(0, 8);
      try {
        const { sessions } = await this.client.session.list({ sessionId, limit: 1 });
        if (sessions[0]) sessionName = sessions[0].name;
      } catch { /* use placeholder */ }

      this.map.set(chatId, {
        workerId: this.workerId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        sessionId,
        sessionName,
      });
      return { sessionId, resumed: true };
    } catch {
      // Fall through to create new
    }
    const sessionId = await this.createNew(chatId);
    return { sessionId, resumed: false };
  }
}
