import { describe, test, expect, mock, beforeEach } from "bun:test";
import { HookRegistry } from "@molf-ai/protocol";

mock.module("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const { SessionManager } = await import("../src/session-mgr.js");
const { ConnectionRegistry } = await import("../src/connection-registry.js");

const noopLogger = { warn: () => {} };

describe("SessionManager hook dispatches", () => {
  let tmpDir: string;
  let mgr: InstanceType<typeof SessionManager>;
  let registry: InstanceType<typeof HookRegistry>;

  beforeEach(() => {
    tmpDir = `/tmp/claude-1000/test-session-hooks-${Date.now()}`;
    mgr = new SessionManager(tmpDir);
    registry = new HookRegistry();
    mgr.setHookRegistry(registry);
  });

  test("session_create observing hook fires on create", async () => {
    const events: any[] = [];
    registry.on("session_create", "test-plugin", (data: any) => {
      events.push(data);
    });

    const session = await mgr.create({ workerId: "w1", workspaceId: "ws1" });

    // Allow microtask queue to flush for observing dispatch
    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe(session.sessionId);
    expect(events[0].workerId).toBe("w1");
    expect(events[0].workspaceId).toBe("ws1");
  });

  test("session_save modifying hook can alter messages", async () => {
    const session = await mgr.create({ workerId: "w1", workspaceId: "ws1" });
    mgr.addMessage(session.sessionId, {
      id: "m1",
      role: "user",
      content: "original",
      timestamp: Date.now(),
    });

    registry.on("session_save", "test-plugin", (data: any) => {
      return {
        messages: data.messages.map((m: any) => ({
          ...m,
          content: m.content + " [modified]",
        })),
      };
    });

    await mgr.save(session.sessionId);

    const loaded = mgr.load(session.sessionId);
    expect(loaded!.messages[0].content).toBe("original [modified]");
  });

  test("session_save hook error does not prevent save", async () => {
    const session = await mgr.create({ workerId: "w1", workspaceId: "ws1" });
    mgr.addMessage(session.sessionId, {
      id: "m1",
      role: "user",
      content: "important data",
      timestamp: Date.now(),
    });

    registry.on("session_save", "bad-plugin", () => {
      throw new Error("Plugin crashed!");
    });

    await mgr.save(session.sessionId);

    const loaded = mgr.load(session.sessionId);
    expect(loaded!.messages[0].content).toBe("important data");
  });

  test("session_delete observing hook fires on delete", async () => {
    const events: any[] = [];
    registry.on("session_delete", "test-plugin", (data: any) => {
      events.push(data);
    });

    const session = await mgr.create({ workerId: "w1", workspaceId: "ws1" });
    const sessionId = session.sessionId;
    mgr.delete(sessionId);

    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe(sessionId);
  });

  test("works without hookRegistry set", async () => {
    const plainMgr = new SessionManager(`/tmp/claude-1000/test-no-hooks-${Date.now()}`);
    const session = await plainMgr.create({ workerId: "w1", workspaceId: "ws1" });
    plainMgr.addMessage(session.sessionId, {
      id: "m1",
      role: "user",
      content: "no hooks",
      timestamp: Date.now(),
    });
    await plainMgr.save(session.sessionId);

    const loaded = plainMgr.load(session.sessionId);
    expect(loaded!.messages[0].content).toBe("no hooks");
  });
});

describe("ConnectionRegistry hook dispatches", () => {
  let registry: InstanceType<typeof HookRegistry>;
  let connRegistry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    registry = new HookRegistry();
    connRegistry = new ConnectionRegistry();
    connRegistry.setHookRegistry(registry);
  });

  test("worker_connect fires on registerWorker", async () => {
    const events: any[] = [];
    registry.on("worker_connect", "test-plugin", (data: any) => {
      events.push(data);
    });

    connRegistry.registerWorker({
      id: "w1",
      name: "test-worker",
      connectedAt: Date.now(),
      tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
      skills: [],
      agents: [],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0].workerId).toBe("w1");
    expect(events[0].name).toBe("test-worker");
    expect(events[0].tools).toHaveLength(1);
  });

  test("worker_disconnect fires on unregister", async () => {
    const events: any[] = [];
    registry.on("worker_disconnect", "test-plugin", (data: any) => {
      events.push(data);
    });

    connRegistry.registerWorker({
      id: "w1",
      name: "test-worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
      agents: [],
    });
    connRegistry.unregister("w1");

    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0].workerId).toBe("w1");
    expect(events[0].reason).toBe("clean");
  });

  test("hook error does not prevent worker registration", async () => {
    registry.on("worker_connect", "bad-plugin", () => {
      throw new Error("Plugin crash!");
    });

    connRegistry.registerWorker({
      id: "w1",
      name: "test-worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
      agents: [],
    });

    // Worker should still be registered
    expect(connRegistry.getWorker("w1")).toBeDefined();
  });
});

describe("HookRegistry dispatch — additional edge cases", () => {
  test("handler throwing non-Error (string) is caught", async () => {
    const errors: unknown[] = [];
    const registry = new HookRegistry();
    registry.on("test", "p", () => {
      throw "string error";
    });
    const result = await registry.dispatchModifying("test", { x: 1 }, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data).toEqual({ x: 1 });
  });

  test("handler throwing undefined is caught", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p", () => {
      throw undefined;
    });
    const result = await registry.dispatchModifying("test", { x: 1 }, noopLogger);
    expect(result.blocked).toBe(false);
  });

  test("removePlugin for non-existent plugin is a no-op", () => {
    const registry = new HookRegistry();
    // Should not throw
    registry.removePlugin("nonexistent");
  });

  test("removePlugin removes handlers and dispatch skips them", async () => {
    const registry = new HookRegistry();
    const handlerA = mock(() => {});
    const handlerB = mock(() => {});

    registry.on("test", "plugin-a", handlerA);
    registry.on("test", "plugin-b", handlerB);

    registry.removePlugin("plugin-a");

    await registry.dispatchModifying("test", { x: 1 }, noopLogger);
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  test("two handlers from same plugin on same hook with different priorities", async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.on("test", "p", () => { order.push(1); }, { priority: 10 });
    registry.on("test", "p", () => { order.push(2); }, { priority: 20 });

    await registry.dispatchModifying("test", {}, noopLogger);
    // Higher priority runs first
    expect(order).toEqual([2, 1]);
  });

  test("multi-plugin chaining on session_save modifies messages sequentially", async () => {
    const registry = new HookRegistry();
    registry.on("session_save", "plugin-a", (data: any) => ({
      messages: data.messages.map((m: any) => ({ ...m, content: m.content + " [A]" })),
    }));
    registry.on("session_save", "plugin-b", (data: any) => ({
      messages: data.messages.map((m: any) => ({ ...m, content: m.content + " [B]" })),
    }));

    const result = await registry.dispatchModifying("session_save", {
      sessionId: "s1",
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }],
    }, noopLogger);

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.data.messages[0].content).toContain("[A]");
      expect(result.data.messages[0].content).toContain("[B]");
    }
  });

  test("priority ordering on session_save — higher priority runs first", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.on("session_save", "low-priority", (data: any) => {
      order.push("low");
      return { messages: data.messages.map((m: any) => ({ ...m, content: m.content + " [low]" })) };
    }, { priority: 10 });
    registry.on("session_save", "high-priority", (data: any) => {
      order.push("high");
      return { messages: data.messages.map((m: any) => ({ ...m, content: m.content + " [high]" })) };
    }, { priority: 20 });

    await registry.dispatchModifying("session_save", {
      sessionId: "s1",
      messages: [{ id: "m1", role: "user", content: "start", timestamp: 1 }],
    }, noopLogger);

    // Higher priority runs first
    expect(order).toEqual(["high", "low"]);
  });

  test("block on non-blockable hook (session_save) is ignored", async () => {
    const warns: string[] = [];
    const warnLogger = { warn: (msg: string) => warns.push(msg) };
    const registry = new HookRegistry();

    registry.on("session_save", "blocker-plugin", () => ({
      block: "should be ignored",
    }));

    const result = await registry.dispatchModifying("session_save", {
      sessionId: "s1",
      messages: [{ id: "m1", role: "user", content: "keep me", timestamp: 1 }],
    }, warnLogger);

    // Should NOT be blocked — session_save is not in BLOCKABLE_HOOKS
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.data.messages[0].content).toBe("keep me");
    }
    expect(warns.some((w) => w.includes("non-blockable"))).toBe(true);
  });

  test("observing dispatch does not block caller", async () => {
    const registry = new HookRegistry();
    let resolved = false;

    registry.on("test", "p", async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    });

    // dispatchObserving returns void (fire-and-forget)
    registry.dispatchObserving("test", {}, noopLogger);

    // Handler hasn't finished yet
    expect(resolved).toBe(false);

    // But it will eventually
    await new Promise((r) => setTimeout(r, 80));
    expect(resolved).toBe(true);
  });
});
