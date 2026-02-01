import { describe, it, expect, beforeEach } from "bun:test";
import { SessionMap } from "../src/session-map.js";

// Minimal stub for the tRPC client
function createMockTrpc() {
  let sessionCounter = 0;
  return {
    session: {
      create: {
        mutate: async (_input: { workerId: string; metadata?: Record<string, unknown> }) => {
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
  });

  it("passes metadata with client and chatId in getOrCreate", async () => {
    let capturedInput: any;
    mockTrpc.session.create.mutate = async (input: any) => {
      capturedInput = input;
      return { sessionId: "s-1", name: "S 1", workerId: input.workerId, createdAt: Date.now() };
    };

    await sessionMap.getOrCreate(42);
    expect(capturedInput.metadata).toEqual({ client: "telegram", chatId: 42 });
  });

  it("passes metadata with client and chatId in createNew", async () => {
    let capturedInput: any;
    mockTrpc.session.create.mutate = async (input: any) => {
      capturedInput = input;
      return { sessionId: "s-1", name: "S 1", workerId: input.workerId, createdAt: Date.now() };
    };

    await sessionMap.createNew(77);
    expect(capturedInput.metadata).toEqual({ client: "telegram", chatId: 77 });
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
      });

      const count = await sessionMap.restore();
      expect(count).toBe(2);
      expect(sessionMap.get(100)).toBe("s-100");
      expect(sessionMap.get(200)).toBe("s-200");
      expect(sessionMap.getEntry(100)?.sessionName).toBe("Restored Session");
    });

    it("skips non-telegram sessions", async () => {
      mockTrpc.session.list.query = async () => ({
        sessions: [
          {
            sessionId: "s-1",
            name: "TUI Session",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 2000,
            messageCount: 5,
            active: false,
            // no metadata
          },
          {
            sessionId: "s-2",
            name: "Other Client",
            workerId: "w-1",
            createdAt: 1000,
            lastActiveAt: 1500,
            messageCount: 1,
            active: false,
            metadata: { client: "tui" },
          },
        ],
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
      });

      const count = await sessionMap.restore();
      expect(count).toBe(0);
      expect(sessionMap.get(100)).toBe(existingId);
    });
  });
});
