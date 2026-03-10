import { getLogger } from "@logtape/logtape";
import { readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { readdir, readFile, writeFile, rename } from "fs/promises";
import { resolve } from "path";
import { lastMessagePreview, errorMessage } from "@molf-ai/protocol";
import type { SessionFile, SessionListItem, SessionMessage } from "@molf-ai/protocol";
import type { HookRegistry } from "@molf-ai/protocol";

const logger = getLogger(["molf", "server", "session"]);

export class SessionCorruptError extends Error {
  constructor(public readonly sessionId: string, cause: unknown) {
    super(`Session ${sessionId} is corrupt`);
    this.name = "SessionCorruptError";
    this.cause = cause;
  }
}

export class SessionManager {
  private sessionsDir: string;
  /** In-memory cache of active sessions */
  private activeSessions = new Map<string, SessionFile>();
  private hookRegistry?: HookRegistry;

  constructor(dataDir: string) {
    this.sessionsDir = resolve(dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Set hook registry for plugin dispatches. */
  setHookRegistry(registry: HookRegistry): void {
    this.hookRegistry = registry;
  }

  async create(params: {
    name?: string;
    workerId: string;
    workspaceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionFile> {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    const session: SessionFile = {
      sessionId,
      name: params.name ?? `Session ${new Date(now).toLocaleString()}`,
      workerId: params.workerId,
      workspaceId: params.workspaceId,
      createdAt: now,
      lastActiveAt: now,
      metadata: params.metadata,
      messages: [],
    };

    this.activeSessions.set(sessionId, session);
    await this.saveToDisk(session);
    logger.info("Session created", { sessionId });

    this.hookRegistry?.dispatchObserving("session_create", {
      sessionId,
      name: session.name,
      workerId: session.workerId,
      workspaceId: session.workspaceId,
    }, { warn: (msg) => logger.warn(msg) });

    return session;
  }

  async list(
    isActive?: (sessionId: string) => boolean,
    filters?: {
      sessionId?: string;
      name?: string;
      workerId?: string;
      active?: boolean;
      metadata?: Record<string, unknown>;
    },
    pagination?: { limit?: number; offset?: number },
  ): Promise<{ sessions: SessionListItem[]; total: number }> {
    const items: SessionListItem[] = [];

    // Read from disk to include sessions not in memory
    if (!existsSync(this.sessionsDir)) return { sessions: items, total: 0 };

    const files = (await readdir(this.sessionsDir)).filter((f) =>
      f.endsWith(".json"),
    );

    for (const file of files) {
      try {
        const sessionId = file.replace(/\.json$/, "");

        // Prefer in-memory data for loaded sessions (avoids disk read + parse)
        const cached = this.activeSessions.get(sessionId);
        const data: SessionFile = cached
          ?? JSON.parse(await readFile(resolve(this.sessionsDir, file), "utf-8")) as SessionFile;

        const lastMsg = data.messages.length > 0
          ? data.messages[data.messages.length - 1]
          : undefined;
        items.push({
          sessionId: data.sessionId,
          name: data.name,
          workerId: data.workerId,
          createdAt: data.createdAt,
          lastActiveAt: data.lastActiveAt,
          messageCount: data.messages.length,
          active: isActive
            ? isActive(data.sessionId)
            : this.activeSessions.has(data.sessionId),
          lastMessage: lastMsg ? lastMessagePreview(lastMsg) : undefined,
          metadata: data.metadata,
        });
      } catch (err) {
        logger.warn("Skipping corrupt session file", { file, error: err });
      }
    }

    let result = items;
    if (filters) {
      result = items.filter((item) => {
        if (filters.sessionId !== undefined && item.sessionId !== filters.sessionId) return false;
        if (filters.name !== undefined && item.name !== filters.name) return false;
        if (filters.workerId !== undefined && item.workerId !== filters.workerId) return false;
        if (filters.active !== undefined && item.active !== filters.active) return false;
        if (filters.metadata) {
          for (const [key, value] of Object.entries(filters.metadata)) {
            if (JSON.stringify(item.metadata?.[key]) !== JSON.stringify(value)) return false;
          }
        }
        return true;
      });
    }

    const sorted = result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const total = sorted.length;
    const offset = pagination?.offset ?? 0;
    const limit = pagination?.limit ?? 50;
    return { sessions: sorted.slice(offset, offset + limit), total };
  }

  /**
   * Load a session by ID.
   * @returns The session data, or `null` if the session file does not exist.
   * @throws {SessionCorruptError} if the file exists but cannot be parsed.
   */
  load(sessionId: string): SessionFile | null {
    // Check memory first
    const cached = this.activeSessions.get(sessionId);
    if (cached) return cached;

    // Load from disk
    const filePath = resolve(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionFile;
      this.activeSessions.set(sessionId, data);
      logger.debug("Session loaded from disk", { sessionId });
      return data;
    } catch (err) {
      throw new SessionCorruptError(sessionId, err);
    }
  }

  async save(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      // Dispatch session_save modifying hook (plugins can alter messages before persistence)
      if (this.hookRegistry) {
        const hookLogger = { warn: (msg: string) => logger.warn(msg) };
        const result = await this.hookRegistry.dispatchModifying("session_save", {
          sessionId,
          messages: session.messages,
        }, hookLogger);
        if (!result.blocked && result.data.messages !== session.messages) {
          session.messages = result.data.messages;
        }
      }

      session.lastActiveAt = Date.now();
      await this.saveToDisk(session);
      logger.debug("Session saved", { sessionId });
    }
  }

  async rename(sessionId: string, name: string): Promise<boolean> {
    const session = this.load(sessionId);
    if (!session) return false;
    session.name = name;
    await this.saveToDisk(session);
    return true;
  }

  delete(sessionId: string): boolean {
    this.activeSessions.delete(sessionId);
    const filePath = resolve(this.sessionsDir, `${sessionId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      logger.info("Session deleted", { sessionId });

      this.hookRegistry?.dispatchObserving("session_delete", {
        sessionId,
      }, { warn: (msg) => logger.warn(msg) });

      return true;
    }
    return false;
  }

  /** Save session to disk and remove from in-memory cache. Idempotent. */
  async release(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    await this.saveToDisk(session);
    this.activeSessions.delete(sessionId);
    logger.debug("Session released", { sessionId });
  }

  getActive(sessionId: string): SessionFile | undefined {
    return this.activeSessions.get(sessionId);
  }

  /** Return IDs of active (in-memory) sessions bound to a worker. */
  listByWorker(workerId: string): string[] {
    const result: string[] = [];
    for (const [id, session] of this.activeSessions) {
      if (session.workerId === workerId) result.push(id);
    }
    return result;
  }

  addMessage(sessionId: string, message: SessionMessage): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not loaded`);
    session.messages.push(message);
    session.lastActiveAt = Date.now();
  }

  getMessages(sessionId: string): SessionMessage[] {
    const session = this.activeSessions.get(sessionId);
    return session?.messages ?? [];
  }

  replaceMessages(sessionId: string, messages: SessionMessage[]): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not loaded`);
    session.messages = messages;
    session.lastActiveAt = Date.now();
  }

  private async saveToDisk(session: SessionFile): Promise<void> {
    const filePath = resolve(this.sessionsDir, `${session.sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(session, null, 2));
      await rename(tmpPath, filePath);
    } catch (err: any) {
      // Ignore ENOENT — the data directory may have been removed during test cleanup
      // while an async release() was still in flight.
      if (err?.code === "ENOENT") return;
      throw err;
    }
  }
}
