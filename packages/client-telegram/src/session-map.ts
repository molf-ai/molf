import type { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";

export interface SessionEntry {
  sessionId: string;
  sessionName: string;
}

/**
 * Maps Telegram chat IDs to Molf session IDs.
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
   */
  async getOrCreate(chatId: number): Promise<string> {
    const existing = this.map.get(chatId);
    if (existing) return existing.sessionId;

    const result = await this.trpc.session.create.mutate({
      workerId: this.workerId,
      metadata: { client: "telegram", chatId },
    });
    this.map.set(chatId, { sessionId: result.sessionId, sessionName: result.name });
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
   * Create a new session for the chat, replacing any existing mapping.
   */
  async createNew(chatId: number): Promise<string> {
    const result = await this.trpc.session.create.mutate({
      workerId: this.workerId,
      metadata: { client: "telegram", chatId },
    });
    this.map.set(chatId, { sessionId: result.sessionId, sessionName: result.name });
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
    const { sessions } = await this.trpc.session.list.query({
      metadata: { client: "telegram" },
    });
    let count = 0;

    for (const session of sessions) {
      const chatId = session.metadata?.chatId;
      if (typeof chatId === "number" && !this.map.has(chatId)) {
        this.map.set(chatId, {
          sessionId: session.sessionId,
          sessionName: session.name,
        });
        count++;
      }
    }

    return count;
  }

  /**
   * Switch to the most recent session for the current worker, or create a new one.
   * Returns the session ID and whether an existing session was resumed.
   */
  async switchToLatest(chatId: number): Promise<{ sessionId: string; resumed: boolean }> {
    try {
      const { sessions } = await this.trpc.session.list.query({ workerId: this.workerId, limit: 1 });
      if (sessions.length > 0) {
        const latest = sessions[0];
        this.map.set(chatId, { sessionId: latest.sessionId, sessionName: latest.name });
        return { sessionId: latest.sessionId, resumed: true };
      }
    } catch {
      // Fall through to create new
    }
    const sessionId = await this.createNew(chatId);
    return { sessionId, resumed: false };
  }
}
