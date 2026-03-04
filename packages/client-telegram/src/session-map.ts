import type { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";

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
  private trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  private workerId: string;

  constructor(
    trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
    workerId: string,
  ) {
    this.trpc = trpc;
    this.workerId = workerId;
  }

  /**
   * Get or create a session for the given chat ID.
   * First-time chats get the default workspace via ensureDefault.
   */
  async getOrCreate(chatId: number): Promise<string> {
    const existing = this.map.get(chatId);
    if (existing) return existing.sessionId;

    const { workspace } = await this.trpc.workspace.ensureDefault.mutate({
      workerId: this.workerId,
    });

    const result = await this.trpc.session.create.mutate({
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
  }

  /**
   * Get the session ID for a chat, or undefined if none exists.
   */
  get(chatId: number): string | undefined {
    return this.map.get(chatId)?.sessionId;
  }

  /**
   * Get the full session entry for a chat, or undefined if none exists.
   */
  getEntry(chatId: number): SessionEntry | undefined {
    return this.map.get(chatId);
  }

  /**
   * Create a new session for the chat in its current workspace.
   */
  async createNew(chatId: number): Promise<string> {
    const entry = this.map.get(chatId);
    let workspaceId: string;
    let workspaceName: string;

    if (entry) {
      workspaceId = entry.workspaceId;
      workspaceName = entry.workspaceName;
    } else {
      const { workspace } = await this.trpc.workspace.ensureDefault.mutate({
        workerId: this.workerId,
      });
      workspaceId = workspace.id;
      workspaceName = workspace.name;
    }

    const result = await this.trpc.session.create.mutate({
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
  }

  /**
   * Check if a chat has an active session.
   */
  has(chatId: number): boolean {
    return this.map.has(chatId);
  }

  /**
   * Get all active chat IDs.
   */
  activeChatIds(): number[] {
    return [...this.map.keys()];
  }

  /**
   * Get all chat IDs currently in the given workspace.
   */
  chatIdsInWorkspace(workspaceId: string): number[] {
    const result: number[] = [];
    for (const [chatId, entry] of this.map) {
      if (entry.workspaceId === workspaceId) result.push(chatId);
    }
    return result;
  }

  /**
   * Switch a chat to a different workspace and session.
   */
  switchWorkspace(chatId: number, workspaceId: string, workspaceName: string, sessionId: string, sessionName: string): void {
    this.map.set(chatId, {
      workerId: this.workerId,
      workspaceId,
      workspaceName,
      sessionId,
      sessionName,
    });
  }

  /**
   * Update the worker ID (e.g., after reconnection or /worker switch).
   */
  setWorkerId(workerId: string): void {
    this.workerId = workerId;
  }

  /**
   * Restore sessions from the server that were created by this Telegram client.
   * Returns the number of restored sessions.
   */
  async restore(): Promise<number> {
    const { workspace } = await this.trpc.workspace.ensureDefault.mutate({
      workerId: this.workerId,
    });

    const { sessions } = await this.trpc.session.list.query({
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

  /**
   * Switch to the default workspace's last session for the current worker.
   * Returns the session ID and whether an existing session was resumed.
   */
  async switchToLatest(chatId: number): Promise<{ sessionId: string; resumed: boolean }> {
    try {
      const { workspace, sessionId } = await this.trpc.workspace.ensureDefault.mutate({
        workerId: this.workerId,
      });

      // Fetch actual session name (ensureDefault only returns sessionId)
      let sessionName = sessionId.slice(0, 8);
      try {
        const { sessions } = await this.trpc.session.list.query({ sessionId, limit: 1 });
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
