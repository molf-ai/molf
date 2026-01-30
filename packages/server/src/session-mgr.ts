import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { SessionFile, SessionListItem, SessionMessage } from "@molf-ai/protocol";

export class SessionManager {
  private sessionsDir: string;
  /** In-memory cache of active sessions */
  private activeSessions = new Map<string, SessionFile>();

  constructor(dataDir: string) {
    this.sessionsDir = resolve(dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  create(params: {
    name?: string;
    workerId: string;
    config?: SessionFile["config"];
  }): SessionFile {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    const session: SessionFile = {
      sessionId,
      name: params.name ?? `Session ${new Date(now).toLocaleString()}`,
      workerId: params.workerId,
      createdAt: now,
      lastActiveAt: now,
      config: params.config,
      messages: [],
    };

    this.activeSessions.set(sessionId, session);
    this.saveToDisk(session);
    return session;
  }

  list(): SessionListItem[] {
    const items: SessionListItem[] = [];

    // Read from disk to include sessions not in memory
    if (!existsSync(this.sessionsDir)) return items;

    const files = readdirSync(this.sessionsDir).filter((f) =>
      f.endsWith(".json"),
    );

    for (const file of files) {
      try {
        const filePath = resolve(this.sessionsDir, file);
        const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionFile;
        items.push({
          sessionId: data.sessionId,
          name: data.name,
          workerId: data.workerId,
          createdAt: data.createdAt,
          lastActiveAt: data.lastActiveAt,
          messageCount: data.messages.length,
          active: this.activeSessions.has(data.sessionId),
        });
      } catch {
        // Skip corrupt files
      }
    }

    return items.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

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
      return data;
    } catch {
      return null;
    }
  }

  save(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
      this.saveToDisk(session);
    }
  }

  delete(sessionId: string): boolean {
    this.activeSessions.delete(sessionId);
    const filePath = resolve(this.sessionsDir, `${sessionId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }

  getActive(sessionId: string): SessionFile | undefined {
    return this.activeSessions.get(sessionId);
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

  private saveToDisk(session: SessionFile): void {
    const filePath = resolve(this.sessionsDir, `${session.sessionId}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2));
  }
}
