import { describe, it, expect, beforeEach } from "vitest";
import { SessionMap } from "../src/session-map.js";

// Minimal stub for the tRPC client (includes workspace.ensureDefault)
function createMockTrpc() {
  let sessionCounter = 0;
  return {
    workspace: {
      ensureDefault: {
        mutate: async (_input: { workerId: string }) => ({
          workspace: {
            id: "ws-default",
            name: "main",
            isDefault: true,
            lastSessionId: "s-latest",
            sessions: [],
            createdAt: Date.now(),
            config: {},
          },
          sessionId: "s-latest",
        }),
      },
    },
    session: {
      create: {
        mutate: async (_input: { workerId: string; workspaceId: string; metadata?: Record<string, unknown> }) => {
          sessionCounter++;
          return { sessionId: `session-${sessionCounter}`, name: `Session ${sessionCounter}`, workerId: _input.workerId, createdAt: Date.now() };
        },
      },
      list: {
        query: async () => ({
          sessions: [] as Array<{
            sessionId: string;
            name: string;
            workerId: string;
            createdAt: number;
            lastActiveAt: number;
            messageCount: number;
            active: boolean;
            metadata?: Record<string, unknown>;
          }>,
          total: 0,
        }),
      },
    },
  } as any;
}

describe("SessionMap", () => {
  let sessionMap: SessionMap;
  let mockTrpc: ReturnType<typeof createMockTrpc>;

  beforeEach(() => {
    mockTrpc = createMockTrpc();
    sessionMap = new SessionMap(mockTrpc as any, "worker-1");
  });

  it("creates a session on first getOrCreate", async () => {
    const sessionId = await sessionMap.getOrCreate(100);
    expect(sessionId).toBe("session-1");
  });

  it("returns existing session on subsequent getOrCreate", async () => {
    const first = await sessionMap.getOrCreate(100);
    const second = await sessionMap.getOrCreate(100);
    expect(first).toBe(second);
    expect(first).toBe("session-1");
  });

  it("creates separate sessions for different chats", async () => {
    const s1 = await sessionMap.getOrCreate(100);
    const s2 = await sessionMap.getOrCreate(200);
    expect(s1).not.toBe(s2);
  });

  it("get returns undefined for unknown chat", () => {
    expect(sessionMap.get(999)).toBeUndefined();
  });

  it("get returns session ID for known chat", async () => {
    await sessionMap.getOrCreate(100);
    expect(sessionMap.get(100)).toBe("session-1");
  });

  it("createNew replaces existing session", async () => {
    const first = await sessionMap.getOrCreate(100);
    const second = await sessionMap.createNew(100);
    expect(first).not.toBe(second);
    expect(sessionMap.get(100)).toBe(second);
  });

  it("has returns false for unknown chat", () => {
    expect(sessionMap.has(999)).toBe(false);
  });

  it("has returns true for known chat", async () => {
    await sessionMap.getOrCreate(100);
    expect(sessionMap.has(100)).toBe(true);
  });

  it("activeChatIds returns all active chats", async () => {
    await sessionMap.getOrCreate(100);
    await sessionMap.getOrCreate(200);
    const ids = sessionMap.activeChatIds();
    expect(ids).toContain(100);
    expect(ids).toContain(200);
    expect(ids.length).toBe(2);
  });

  it("getEntry returns undefined for unknown chat", () => {
    expect(sessionMap.getEntry(999)).toBeUndefined();
  });

  it("getEntry returns full entry for known chat", async () => {
    await sessionMap.getOrCreate(100);
    const entry = sessionMap.getEntry(100);
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe("session-1");
    expect(entry!.sessionName).toBe("Session 1");
    expect(entry!.workerId).toBe("worker-1");
    expect(entry!.workspaceId).toBe("ws-default");
    expect(entry!.workspaceName).toBe("main");
  });

  it("passes metadata and workspaceId in getOrCreate", async () => {
    let capturedInput: any;
    mockTrpc.session.create.mutate = async (input: any) => {
      capturedInput = input;
      return { sessionId: "s-1", name: "S 1", workerId: input.workerId, createdAt: Date.now() };
    };

    await sessionMap.getOrCreate(42);
    expect(capturedInput.metadata).toEqual({ client: "telegram", chatId: 42 });
    expect(capturedInput.workspaceId).toBe("ws-default");
  });

  it("passes metadata and workspaceId in createNew", async () => {
    let capturedInput: any;
    mockTrpc.session.create.mutate = async (input: any) => {
      capturedInput = input;
      return { sessionId: "s-1", name: "S 1", workerId: input.workerId, createdAt: Date.now() };
    };

    await sessionMap.createNew(77);
    expect(capturedInput.metadata).toEqual({ client: "telegram", chatId: 77 });
    expect(capturedInput.workspaceId).toBe("ws-default");
  });

  it("chatIdsInWorkspace returns chats in the given workspace", async () => {
    await sessionMap.getOrCreate(100);
    await sessionMap.getOrCreate(200);
    expect(sessionMap.chatIdsInWorkspace("ws-default")).toContain(100);
    expect(sessionMap.chatIdsInWorkspace("ws-default")).toContain(200);
    expect(sessionMap.chatIdsInWorkspace("ws-other")).toHaveLength(0);
  });

  it("switchWorkspace updates entry to new workspace", async () => {
    await sessionMap.getOrCreate(100);
    sessionMap.switchWorkspace(100, "ws-new", "other", "s-new", "New Session");
    const entry = sessionMap.getEntry(100);
    expect(entry!.workspaceId).toBe("ws-new");
    expect(entry!.workspaceName).toBe("other");
    expect(entry!.sessionId).toBe("s-new");
    expect(entry!.sessionName).toBe("New Session");
  });

  describe("restore", () => {
    it("restores telegram sessions from server", async () => {
      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-100",
            name: "Restored Session",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 2000,
            messageCount: 3,
            active: false,
            metadata: { client: "telegram", chatId: 100 },
          },
          {
            sessionId: "s-200",
            name: "Another Session",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 1500,
            messageCount: 1,
            active: false,
            metadata: { client: "telegram", chatId: 200 },
          },
        ],
        total: 2,
      });

      const count = await sessionMap.restore();
      expect(count).toBe(2);
      expect(sessionMap.get(100)).toBe("s-100");
      expect(sessionMap.get(200)).toBe("s-200");
      expect(sessionMap.getEntry(100)?.sessionName).toBe("Restored Session");
      expect(sessionMap.getEntry(100)?.workspaceId).toBe("ws-default");
      expect(sessionMap.getEntry(100)?.workspaceName).toBe("main");
    });

    it("passes metadata and workerId filter to server query", async () => {
      let capturedInput: any;
      mockTrpc.session.list.query = async (input: any) => {
        capturedInput = input;
        return { sessions: [], total: 0 };
      };

      await sessionMap.restore();
      expect(capturedInput).toEqual({ metadata: { client: "telegram" }, workerId: "worker-1" });
    });

    it("skips sessions without numeric chatId", async () => {
      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-1",
            name: "No ChatId",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 2000,
            messageCount: 5,
            active: false,
            metadata: { client: "telegram" },
          },
          {
            sessionId: "s-2",
            name: "String ChatId",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 1500,
            messageCount: 1,
            active: false,
            metadata: { client: "telegram", chatId: "not-a-number" },
          },
        ],
        total: 2,
      });

      const count = await sessionMap.restore();
      expect(count).toBe(0);
      expect(sessionMap.activeChatIds()).toHaveLength(0);
    });

    it("first match per chatId wins (sorted by lastActiveAt desc)", async () => {
      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-newer",
            name: "Newer",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 3000,
            messageCount: 5,
            active: false,
            metadata: { client: "telegram", chatId: 100 },
          },
          {
            sessionId: "s-older",
            name: "Older",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 1000,
            messageCount: 1,
            active: false,
            metadata: { client: "telegram", chatId: 100 },
          },
        ],
        total: 2,
      });

      const count = await sessionMap.restore();
      expect(count).toBe(1);
      expect(sessionMap.get(100)).toBe("s-newer");
    });

    it("does not overwrite existing mappings", async () => {
      // Pre-populate
      await sessionMap.getOrCreate(100);
      const existingId = sessionMap.get(100);

      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-from-server",
            name: "From Server",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 2000,
            messageCount: 3,
            active: false,
            metadata: { client: "telegram", chatId: 100 },
          },
        ],
        total: 1,
      });

      const count = await sessionMap.restore();
      expect(count).toBe(0);
      expect(sessionMap.get(100)).toBe(existingId);
    });
  });

  describe("switchToLatest", () => {
    it("resumes with workspace's last session", async () => {
      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-latest",
            name: "Latest Session",
            workerId: "worker-1",
            createdAt: 1000,
            lastActiveAt: 3000,
            messageCount: 5,
            active: false,
          },
        ],
        total: 1,
      });

      const result = await sessionMap.switchToLatest(100);
      expect(result.sessionId).toBe("s-latest");
      expect(result.resumed).toBe(true);
      expect(sessionMap.get(100)).toBe("s-latest");
      expect(sessionMap.getEntry(100)?.sessionName).toBe("Latest Session");
      expect(sessionMap.getEntry(100)?.workspaceName).toBe("main");
      expect(sessionMap.getEntry(100)?.workspaceId).toBe("ws-default");
    });

    it("falls back to new session when ensureDefault throws", async () => {
      let callCount = 0;
      mockTrpc.workspace.ensureDefault.mutate = async () => {
        callCount++;
        if (callCount === 1) throw new Error("Connection failed");
        // Succeed on subsequent calls (createNew also calls ensureDefault)
        return {
          workspace: { id: "ws-default", name: "main", isDefault: true, lastSessionId: "s-latest", sessions: [], createdAt: Date.now(), config: {} },
          sessionId: "s-latest",
        };
      };

      const result = await sessionMap.switchToLatest(100);
      expect(result.resumed).toBe(false);
      expect(result.sessionId).toBeTruthy();
      expect(sessionMap.get(100)).toBe(result.sessionId);
    });

    it("uses sessionId prefix when session name query fails", async () => {
      mockTrpc.session.list.query = async () => {
        throw new Error("Query failed");
      };

      const result = await sessionMap.switchToLatest(100);
      expect(result.sessionId).toBe("s-latest");
      expect(result.resumed).toBe(true);
      expect(sessionMap.getEntry(100)?.sessionName).toBe("s-latest".slice(0, 8));
    });
  });
});
