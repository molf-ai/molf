import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/session-mgr.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { EventBus } from "../src/event-bus.js";
import { ToolDispatch } from "../src/tool-dispatch.js";
import { AgentRunner } from "../src/agent-runner.js";
import type { AgentEvent, ToolCallRequest } from "@molf-ai/protocol";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-comp-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// --- ToolDispatch concurrent behavior ---

describe("ToolDispatch: concurrent dispatches", () => {
  test("three concurrent dispatches to same worker all resolve", async () => {
    const dispatch = new ToolDispatch();
    const workerId = "concurrent-worker";

    // Start consumer in background
    const received: ToolCallRequest[] = [];
    const consume = async () => {
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker(workerId, ac.signal);
      for await (const request of gen) {
        received.push(request);
        // Simulate processing time
        await new Promise((r) => setTimeout(r, 10));
        dispatch.resolveToolCall(request.toolCallId, {
          echo: request.toolCallId,
        });
        if (received.length >= 3) {
          ac.abort();
        }
      }
    };
    const consumerDone = consume();

    // Small delay for subscription to establish
    await new Promise((r) => setTimeout(r, 20));

    // Dispatch 3 concurrently
    const [r1, r2, r3] = await Promise.all([
      dispatch.dispatch(workerId, {
        toolCallId: "cc_1",
        toolName: "tool",
        args: { n: 1 },
      }),
      dispatch.dispatch(workerId, {
        toolCallId: "cc_2",
        toolName: "tool",
        args: { n: 2 },
      }),
      dispatch.dispatch(workerId, {
        toolCallId: "cc_3",
        toolName: "tool",
        args: { n: 3 },
      }),
    ]);

    await consumerDone;

    expect(r1.result).toEqual({ echo: "cc_1" });
    expect(r2.result).toEqual({ echo: "cc_2" });
    expect(r3.result).toEqual({ echo: "cc_3" });
    expect(received).toHaveLength(3);
  });

  test("dispatches queued before subscription are drained in order", async () => {
    const dispatch = new ToolDispatch();
    const workerId = "queue-order-worker";

    // Queue 3 dispatches BEFORE subscribing
    const promises = [
      dispatch.dispatch(workerId, {
        toolCallId: "q_1",
        toolName: "tool",
        args: {},
      }),
      dispatch.dispatch(workerId, {
        toolCallId: "q_2",
        toolName: "tool",
        args: {},
      }),
      dispatch.dispatch(workerId, {
        toolCallId: "q_3",
        toolName: "tool",
        args: {},
      }),
    ];

    // Now subscribe
    const received: string[] = [];
    const ac = new AbortController();
    const consume = async () => {
      for await (const request of dispatch.subscribeWorker(
        workerId,
        ac.signal,
      )) {
        received.push(request.toolCallId);
        dispatch.resolveToolCall(request.toolCallId, { ok: true });
        if (received.length >= 3) ac.abort();
      }
    };
    const consumerDone = consume();

    const results = await Promise.all(promises);
    await consumerDone;

    expect(received).toEqual(["q_1", "q_2", "q_3"]);
    expect(results.every((r) => (r.result as any).ok === true)).toBe(true);
  });

  test("workerDisconnected cleans up queues and listeners", async () => {
    const dispatch = new ToolDispatch();
    const workerId = "cleanup-worker";

    // Queue a dispatch
    const dispatchPromise = dispatch.dispatch(workerId, {
      toolCallId: "cleanup_1",
      toolName: "tool",
      args: {},
    });

    // Disconnect worker — pending dispatch should NOT resolve
    // (the dispatch promise stays pending since there's no reject mechanism)
    dispatch.workerDisconnected(workerId);

    // New subscription should not receive the old queued request
    const received: string[] = [];
    const ac = new AbortController();

    // Dispatch a NEW request
    const newPromise = dispatch.dispatch(workerId, {
      toolCallId: "cleanup_new",
      toolName: "tool",
      args: {},
    });

    const consume = async () => {
      for await (const request of dispatch.subscribeWorker(
        workerId,
        ac.signal,
      )) {
        received.push(request.toolCallId);
        dispatch.resolveToolCall(request.toolCallId, { fresh: true });
        ac.abort();
      }
    };
    await consume();

    const newResult = await newPromise;
    expect(newResult.result).toEqual({ fresh: true });
    expect(received).toEqual(["cleanup_new"]);
    // Old dispatch is still pending (lost) — this is expected behavior
  });

  test("abort signal terminates subscription", async () => {
    const dispatch = new ToolDispatch();
    const workerId = "abort-worker";

    const ac = new AbortController();
    const received: string[] = [];

    const consume = async () => {
      for await (const request of dispatch.subscribeWorker(
        workerId,
        ac.signal,
      )) {
        received.push(request.toolCallId);
        dispatch.resolveToolCall(request.toolCallId, { ok: true });
      }
    };
    const consumerDone = consume();

    await new Promise((r) => setTimeout(r, 20));

    // Dispatch one request
    const r1 = dispatch.dispatch(workerId, {
      toolCallId: "abort_1",
      toolName: "tool",
      args: {},
    });
    await r1;

    // Abort the subscription
    ac.abort();
    await consumerDone;

    expect(received).toEqual(["abort_1"]);
  });
});

// --- EventBus multi-subscriber ---

describe("EventBus: multi-subscriber integration", () => {
  test("three subscribers all receive every event", () => {
    const bus = new EventBus();
    const sessionId = "multi-sub-session";

    const r1: AgentEvent[] = [];
    const r2: AgentEvent[] = [];
    const r3: AgentEvent[] = [];

    bus.subscribe(sessionId, (e) => r1.push(e));
    bus.subscribe(sessionId, (e) => r2.push(e));
    bus.subscribe(sessionId, (e) => r3.push(e));

    const events: AgentEvent[] = [
      { type: "status_change", status: "streaming" },
      { type: "content_delta", delta: "Hi", content: "Hi" },
      { type: "status_change", status: "idle" },
    ];

    for (const event of events) {
      bus.emit(sessionId, event);
    }

    expect(r1).toEqual(events);
    expect(r2).toEqual(events);
    expect(r3).toEqual(events);
  });

  test("unsubscribing one does not affect others", () => {
    const bus = new EventBus();
    const sessionId = "unsub-session";

    const r1: AgentEvent[] = [];
    const r2: AgentEvent[] = [];

    const unsub1 = bus.subscribe(sessionId, (e) => r1.push(e));
    bus.subscribe(sessionId, (e) => r2.push(e));

    bus.emit(sessionId, { type: "status_change", status: "streaming" });
    unsub1();
    bus.emit(sessionId, { type: "status_change", status: "idle" });

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(2);
  });

  test("hasListeners returns false after all unsubscribe", () => {
    const bus = new EventBus();
    const sessionId = "all-unsub";

    const u1 = bus.subscribe(sessionId, () => {});
    const u2 = bus.subscribe(sessionId, () => {});

    expect(bus.hasListeners(sessionId)).toBe(true);
    u1();
    expect(bus.hasListeners(sessionId)).toBe(true);
    u2();
    expect(bus.hasListeners(sessionId)).toBe(false);
  });
});

// --- AgentRunner error paths ---

describe("AgentRunner: error paths (component integration)", () => {
  test("prompt throws for nonexistent session", async () => {
    const sessionMgr = new SessionManager(testDir);
    const eventBus = new EventBus();
    const connRegistry = new ConnectionRegistry();
    const toolDispatch = new ToolDispatch();
    const runner = new AgentRunner(
      sessionMgr,
      eventBus,
      connRegistry,
      toolDispatch,
    );

    try {
      await runner.prompt("nonexistent-session", "Hello");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });

  test("prompt throws when worker is disconnected", async () => {
    const sessionMgr = new SessionManager(testDir);
    const eventBus = new EventBus();
    const connRegistry = new ConnectionRegistry();
    const toolDispatch = new ToolDispatch();
    const runner = new AgentRunner(
      sessionMgr,
      eventBus,
      connRegistry,
      toolDispatch,
    );

    // Register worker, create session, then disconnect worker
    connRegistry.registerWorker({
      id: "temp-worker",
      name: "temp",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });

    const session = sessionMgr.create({ workerId: "temp-worker" });

    // Disconnect the worker
    connRegistry.unregister("temp-worker");

    try {
      await runner.prompt(session.sessionId, "Hello");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("disconnected");
    }
  });

  test("getStatus returns idle for unknown session", () => {
    const sessionMgr = new SessionManager(testDir);
    const eventBus = new EventBus();
    const connRegistry = new ConnectionRegistry();
    const toolDispatch = new ToolDispatch();
    const runner = new AgentRunner(
      sessionMgr,
      eventBus,
      connRegistry,
      toolDispatch,
    );

    expect(runner.getStatus("unknown")).toBe("idle");
  });

  test("abort returns false for non-active session", () => {
    const sessionMgr = new SessionManager(testDir);
    const eventBus = new EventBus();
    const connRegistry = new ConnectionRegistry();
    const toolDispatch = new ToolDispatch();
    const runner = new AgentRunner(
      sessionMgr,
      eventBus,
      connRegistry,
      toolDispatch,
    );

    expect(runner.abort("non-active")).toBe(false);
  });
});

// --- ConnectionRegistry + SessionManager integration ---

describe("ConnectionRegistry + SessionManager integration", () => {
  test("creating session verifies worker exists in registry", () => {
    const sessionMgr = new SessionManager(testDir);
    const connRegistry = new ConnectionRegistry();

    connRegistry.registerWorker({
      id: "verified-worker",
      name: "verified",
      connectedAt: Date.now(),
      tools: [
        {
          name: "tool_a",
          description: "Tool A",
          inputSchema: { type: "object" },
        },
      ],
      skills: [],
    });

    // Session can be created for any workerId (session mgr doesn't validate)
    const session = sessionMgr.create({ workerId: "verified-worker" });
    expect(session.workerId).toBe("verified-worker");

    // But the router checks worker exists before creating session
    const worker = connRegistry.getWorker(session.workerId);
    expect(worker).toBeDefined();
    expect(worker!.tools).toHaveLength(1);
  });

  test("worker counts track registration and unregistration", () => {
    const connRegistry = new ConnectionRegistry();

    connRegistry.registerWorker({
      id: "w1",
      name: "w1",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    connRegistry.registerWorker({
      id: "w2",
      name: "w2",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    connRegistry.registerClient({
      id: "c1",
      name: "c1",
      connectedAt: Date.now(),
    });

    expect(connRegistry.counts()).toEqual({ workers: 2, clients: 1 });

    connRegistry.unregister("w1");
    expect(connRegistry.counts()).toEqual({ workers: 1, clients: 1 });
    expect(connRegistry.isConnected("w1")).toBe(false);
    expect(connRegistry.isConnected("w2")).toBe(true);
  });

  test("duplicate worker registration throws", () => {
    const connRegistry = new ConnectionRegistry();

    connRegistry.registerWorker({
      id: "dup-w",
      name: "dup",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });

    expect(() =>
      connRegistry.registerWorker({
        id: "dup-w",
        name: "dup2",
        connectedAt: Date.now(),
        tools: [],
        skills: [],
      }),
    ).toThrow("already exists");
  });

  test("client registration overwrites silently", () => {
    const connRegistry = new ConnectionRegistry();

    connRegistry.registerClient({
      id: "c1",
      name: "first",
      connectedAt: Date.now(),
    });
    connRegistry.registerClient({
      id: "c1",
      name: "second",
      connectedAt: Date.now(),
    });

    const client = connRegistry.get("c1");
    expect(client!.name).toBe("second");
  });
});

// --- Full component wiring: ToolDispatch + EventBus + SessionManager ---

describe("Full component wiring", () => {
  test("tool dispatch result is independent per tool call ID", async () => {
    const dispatch = new ToolDispatch();
    const workerId = "wired-worker";

    // Simulate worker subscribing
    const ac = new AbortController();
    const processedIds: string[] = [];

    const consumer = async () => {
      for await (const req of dispatch.subscribeWorker(workerId, ac.signal)) {
        processedIds.push(req.toolCallId);
        // Return different results per call
        if (req.toolName === "success_tool") {
          dispatch.resolveToolCall(req.toolCallId, { success: true });
        } else {
          dispatch.resolveToolCall(req.toolCallId, undefined, "Unknown tool");
        }
        if (processedIds.length >= 2) ac.abort();
      }
    };
    const done = consumer();

    await new Promise((r) => setTimeout(r, 20));

    const [r1, r2] = await Promise.all([
      dispatch.dispatch(workerId, {
        toolCallId: "wired_1",
        toolName: "success_tool",
        args: {},
      }),
      dispatch.dispatch(workerId, {
        toolCallId: "wired_2",
        toolName: "unknown_tool",
        args: {},
      }),
    ]);

    await done;

    expect(r1.result).toEqual({ success: true });
    expect(r1.error).toBeUndefined();
    expect(r2.result).toBeUndefined();
    expect(r2.error).toBe("Unknown tool");
  });

  test("event bus emits tool call lifecycle events correctly", () => {
    const eventBus = new EventBus();
    const sessionId = "lifecycle-session";

    const events: AgentEvent[] = [];
    eventBus.subscribe(sessionId, (e) => events.push(e));

    // Simulate agent loop event sequence
    eventBus.emit(sessionId, { type: "status_change", status: "streaming" });
    eventBus.emit(sessionId, {
      type: "content_delta",
      delta: "Let me ",
      content: "Let me ",
    });
    eventBus.emit(sessionId, {
      type: "content_delta",
      delta: "check.",
      content: "Let me check.",
    });
    eventBus.emit(sessionId, {
      type: "status_change",
      status: "executing_tool",
    });
    eventBus.emit(sessionId, {
      type: "tool_call_start",
      toolCallId: "tc1",
      toolName: "read_file",
      arguments: '{"path":"test.txt"}',
    });
    eventBus.emit(sessionId, {
      type: "tool_call_end",
      toolCallId: "tc1",
      toolName: "read_file",
      result: "file contents",
    });
    eventBus.emit(sessionId, { type: "status_change", status: "streaming" });
    eventBus.emit(sessionId, {
      type: "content_delta",
      delta: "Done.",
      content: "Done.",
    });
    eventBus.emit(sessionId, {
      type: "turn_complete",
      message: {
        id: "m1",
        role: "assistant",
        content: "Done.",
        timestamp: Date.now(),
      },
    });
    eventBus.emit(sessionId, { type: "status_change", status: "idle" });

    expect(events).toHaveLength(10);

    // Verify the lifecycle sequence
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "status_change",
      "content_delta",
      "content_delta",
      "status_change",
      "tool_call_start",
      "tool_call_end",
      "status_change",
      "content_delta",
      "turn_complete",
      "status_change",
    ]);

    // Verify specific event data
    const toolStart = events[4] as any;
    expect(toolStart.toolName).toBe("read_file");
    expect(toolStart.arguments).toBe('{"path":"test.txt"}');

    const toolEnd = events[5] as any;
    expect(toolEnd.result).toBe("file contents");

    const turnComplete = events[8] as any;
    expect(turnComplete.message.content).toBe("Done.");
  });

  test("session messages track the full conversation", () => {
    const sessionMgr = new SessionManager(testDir);
    const session = sessionMgr.create({
      workerId: "conv-worker",
      name: "Conversation Test",
    });

    // Simulate a multi-turn conversation
    sessionMgr.addMessage(session.sessionId, {
      id: "turn1_user",
      role: "user",
      content: "What is 2+2?",
      timestamp: Date.now(),
    });
    sessionMgr.addMessage(session.sessionId, {
      id: "turn1_asst",
      role: "assistant",
      content: "2+2 = 4",
      timestamp: Date.now(),
    });
    sessionMgr.addMessage(session.sessionId, {
      id: "turn2_user",
      role: "user",
      content: "And 3+3?",
      timestamp: Date.now(),
    });
    sessionMgr.addMessage(session.sessionId, {
      id: "turn2_asst",
      role: "assistant",
      content: "3+3 = 6",
      timestamp: Date.now(),
    });

    const messages = sessionMgr.getMessages(session.sessionId);
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");

    // Save and reload
    sessionMgr.save(session.sessionId);
    const freshMgr = new SessionManager(testDir);
    const loaded = freshMgr.load(session.sessionId);
    expect(loaded!.messages).toHaveLength(4);
    expect(loaded!.messages[3].content).toBe("3+3 = 6");
  });
});
