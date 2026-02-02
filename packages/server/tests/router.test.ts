import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../src/session-mgr.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { EventBus } from "../src/event-bus.js";
import { ToolDispatch } from "../src/tool-dispatch.js";
import { AgentRunner } from "../src/agent-runner.js";
import { appRouter } from "../src/router.js";
import { initTRPC } from "@trpc/server";
import type { ServerContext } from "../src/context.js";

const t = initTRPC.context<ServerContext>().create();
const createCallerFactory = t.createCallerFactory;

let tmp: TmpDir;
let sessionMgr: SessionManager;
let connectionRegistry: ConnectionRegistry;
let eventBus: EventBus;
let toolDispatch: ToolDispatch;
let agentRunner: AgentRunner;

function makeCaller(token: string | null = "valid-token") {
  const createCaller = createCallerFactory(appRouter);
  return createCaller({
    token,
    clientId: "test-client",
    sessionMgr,
    connectionRegistry,
    agentRunner,
    eventBus,
    toolDispatch,
    dataDir: tmp.path,
  });
}

beforeAll(() => {
  tmp = createTmpDir();
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  agentRunner = new AgentRunner(sessionMgr, eventBus, connectionRegistry, toolDispatch);
});

afterAll(() => { tmp.cleanup(); });

describe("auth middleware", () => {
  test("authed procedure with valid token", async () => {
    const caller = makeCaller("valid-token");
    const result = await caller.session.list();
    expect(result.sessions).toBeDefined();
  });

  test("authed procedure with null token", async () => {
    const caller = makeCaller(null);
    await expect(caller.session.list()).rejects.toThrow("Missing authentication token");
  });
});

describe("session procedures", () => {
  test("session.create with valid worker", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const result = await caller.session.create({ workerId });
    expect(result.sessionId).toBeTruthy();
    expect(result.workerId).toBe(workerId);
    connectionRegistry.unregister(workerId);
  });

  test("session.create with nonexistent worker", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.create({ workerId: "550e8400-e29b-41d4-a716-446655440000" }),
    ).rejects.toThrow("not found");
  });

  test("session.list", async () => {
    const caller = makeCaller();
    const result = await caller.session.list();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("session.load nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.load({ sessionId: "nonexistent" }),
    ).rejects.toThrow("not found");
  });

  test("session.load success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    const loaded = await caller.session.load({ sessionId: created.sessionId });
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.workerId).toBe(workerId);
    expect(Array.isArray(loaded.messages)).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("session.delete existing", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    const result = await caller.session.delete({ sessionId: created.sessionId });
    expect(result.deleted).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("session.delete nonexistent returns deleted=false", async () => {
    const caller = makeCaller();
    const result = await caller.session.delete({ sessionId: "nonexistent" });
    expect(result.deleted).toBe(false);
  });

  test("session.rename nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.rename({ sessionId: "nonexistent", name: "New" }),
    ).rejects.toThrow("not found");
  });

  test("session.rename success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    const result = await caller.session.rename({ sessionId: created.sessionId, name: "Renamed" });
    expect(result.renamed).toBe(true);
    const loaded = await caller.session.load({ sessionId: created.sessionId });
    expect(loaded.name).toBe("Renamed");
    connectionRegistry.unregister(workerId);
  });
});

describe("session.list with workerId filter", () => {
  test("returns only sessions for the specified worker", async () => {
    const workerIdA = crypto.randomUUID();
    const workerIdB = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerIdA,
      name: "WorkerA",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    connectionRegistry.registerWorker({
      id: workerIdB,
      name: "WorkerB",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId: workerIdA });
    await caller.session.create({ workerId: workerIdA });
    await caller.session.create({ workerId: workerIdB });

    const filteredA = await caller.session.list({ workerId: workerIdA });
    expect(filteredA.sessions.length).toBe(2);
    expect(filteredA.sessions.every((s) => s.workerId === workerIdA)).toBe(true);

    const filteredB = await caller.session.list({ workerId: workerIdB });
    expect(filteredB.sessions.length).toBe(1);
    expect(filteredB.sessions[0].workerId).toBe(workerIdB);

    connectionRegistry.unregister(workerIdA);
    connectionRegistry.unregister(workerIdB);
  });

  test("returns all sessions when no workerId filter", async () => {
    const caller = makeCaller();
    const result = await caller.session.list();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("returns all sessions when undefined input", async () => {
    const caller = makeCaller();
    const result = await caller.session.list(undefined);
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("limit restricts returned sessions", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "LimitWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId });
    await caller.session.create({ workerId });
    await caller.session.create({ workerId });

    const result = await caller.session.list({ workerId, limit: 2 });
    expect(result.sessions.length).toBe(2);
    expect(result.total).toBe(3);

    connectionRegistry.unregister(workerId);
  });

  test("offset skips sessions", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "OffsetWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId });
    await caller.session.create({ workerId });
    await caller.session.create({ workerId });

    const all = await caller.session.list({ workerId });
    const result = await caller.session.list({ workerId, offset: 1 });
    expect(result.total).toBe(3);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0].sessionId).toBe(all.sessions[1].sessionId);

    connectionRegistry.unregister(workerId);
  });

  test("returns only sessions matching metadata filter", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "MetaWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId, metadata: { client: "telegram", chatId: 100 } });
    await caller.session.create({ workerId, metadata: { client: "telegram", chatId: 200 } });
    await caller.session.create({ workerId, metadata: { client: "tui" } });

    const filtered = await caller.session.list({ metadata: { client: "telegram" } });
    expect(filtered.sessions.length).toBe(2);
    expect(filtered.sessions.every((s) => s.metadata?.client === "telegram")).toBe(true);

    connectionRegistry.unregister(workerId);
  });
});

describe("session.list active flag", () => {
  test("active reflects EventBus listeners, not just cache", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ActiveFlagWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });

    // No listeners, agent idle → should be inactive
    const list1 = await caller.session.list();
    const item1 = list1.sessions.find((s) => s.sessionId === created.sessionId);
    expect(item1!.active).toBe(false);

    // Subscribe a listener → should be active
    const unsub = eventBus.subscribe(created.sessionId, () => {});
    const list2 = await caller.session.list();
    const item2 = list2.sessions.find((s) => s.sessionId === created.sessionId);
    expect(item2!.active).toBe(true);

    unsub();
    connectionRegistry.unregister(workerId);
  });
});

describe("subscription procedures", () => {
  test("agent.onEvents subscription yields events from EventBus", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "SubWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });

    const ac = new AbortController();
    const received: any[] = [];

    // Start subscription
    const iterable = await caller.agent.onEvents(
      { sessionId: created.sessionId },
      { signal: ac.signal },
    );

    // Collect events in background
    const collecting = (async () => {
      for await (const event of iterable) {
        received.push(event);
        if (event.type === "turn_complete") break;
      }
    })();

    // Emit events
    await Bun.sleep(20);
    eventBus.emit(created.sessionId, { type: "status_change", status: "streaming" });
    eventBus.emit(created.sessionId, { type: "content_delta", delta: "hi", content: "hi" });
    eventBus.emit(created.sessionId, {
      type: "turn_complete",
      message: { id: "m1", role: "assistant", content: "hi", timestamp: Date.now() },
    });

    await collecting;
    ac.abort();

    expect(received.length).toBe(3);
    expect(received[0].type).toBe("status_change");
    expect(received[1].type).toBe("content_delta");
    expect(received[2].type).toBe("turn_complete");
    connectionRegistry.unregister(workerId);
  });

  test("worker.onToolCall subscription yields dispatched tool calls", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ToolSubWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();

    const ac = new AbortController();
    const received: any[] = [];

    const iterable = await caller.worker.onToolCall(
      { workerId },
      { signal: ac.signal },
    );

    const collecting = (async () => {
      for await (const req of iterable) {
        received.push(req);
        break; // one is enough
      }
    })();

    await Bun.sleep(20);
    // Dispatch a tool call to trigger the subscription
    toolDispatch.dispatch(workerId, {
      toolCallId: "tc_sub_1",
      toolName: "echo",
      args: { text: "hello" },
    });

    await collecting;
    ac.abort();

    expect(received.length).toBe(1);
    expect(received[0].toolCallId).toBe("tc_sub_1");
    expect(received[0].toolName).toBe("echo");

    // Clean up the pending dispatch
    toolDispatch.resolveToolCall("tc_sub_1", "done");
    connectionRegistry.unregister(workerId);
  });
});

describe("agent procedures", () => {
  test("agent.list with connected workers", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ListWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const result = await caller.agent.list();
    expect(result.workers.length).toBeGreaterThanOrEqual(1);
    connectionRegistry.unregister(workerId);
  });

  test("agent.abort", async () => {
    const caller = makeCaller();
    const result = await caller.agent.abort({ sessionId: "nonexistent" });
    expect(result.aborted).toBe(false);
  });

  test("agent.status", async () => {
    const caller = makeCaller();
    const result = await caller.agent.status({ sessionId: "nonexistent" });
    expect(result.status).toBe("idle");
  });

  test("agent.prompt session not found", async () => {
    const caller = makeCaller();
    await expect(
      caller.agent.prompt({ sessionId: "nonexistent", text: "hello" }),
    ).rejects.toThrow("not found");
  });

  test("agent.prompt busy error maps to CONFLICT", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "BusyWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });

    const origPrompt = agentRunner.prompt.bind(agentRunner);
    const { AgentBusyError } = await import("../src/agent-runner.js");
    (agentRunner as any).prompt = async () => {
      throw new AgentBusyError();
    };

    try {
      await expect(
        caller.agent.prompt({ sessionId: created.sessionId, text: "hello" }),
      ).rejects.toThrow("already processing");
    } finally {
      (agentRunner as any).prompt = origPrompt;
      connectionRegistry.unregister(workerId);
    }
  });

  test("agent.prompt generic error maps to INTERNAL_SERVER_ERROR", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ErrorWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });

    // Override agentRunner.prompt to throw a generic Error
    const origPrompt = agentRunner.prompt.bind(agentRunner);
    (agentRunner as any).prompt = async () => {
      throw new Error("unexpected");
    };

    try {
      await expect(
        caller.agent.prompt({ sessionId: created.sessionId, text: "hello" }),
      ).rejects.toThrow("unexpected");
    } finally {
      (agentRunner as any).prompt = origPrompt;
      connectionRegistry.unregister(workerId);
    }
  });

  test("agent.prompt worker disconnected", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    // Disconnect the worker
    connectionRegistry.unregister(workerId);
    await expect(
      caller.agent.prompt({ sessionId: created.sessionId, text: "hello" }),
    ).rejects.toThrow("disconnected");
  });
});

describe("tool procedures", () => {
  test("tool.list nonexistent session", async () => {
    const caller = makeCaller();
    await expect(
      caller.tool.list({ sessionId: "nonexistent" }),
    ).rejects.toThrow("not found");
  });

  test("tool.list with valid session and connected worker", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ToolWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo tool", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    const result = await caller.tool.list({ sessionId: created.sessionId });
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].name).toBe("echo");
    connectionRegistry.unregister(workerId);
  });

  test("tool.list with disconnected worker returns empty", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId });
    connectionRegistry.unregister(workerId);
    const result = await caller.tool.list({ sessionId: created.sessionId });
    expect(result.tools).toEqual([]);
  });

  test("tool.approve returns applied=true", async () => {
    const caller = makeCaller();
    const result = await caller.tool.approve({ sessionId: "s1", toolCallId: "tc1" });
    expect(result.applied).toBe(true);
  });

  test("tool.deny returns applied=false", async () => {
    const caller = makeCaller();
    const result = await caller.tool.deny({ sessionId: "s1", toolCallId: "tc1" });
    expect(result.applied).toBe(false);
  });
});

describe("worker procedures", () => {
  test("worker.register", async () => {
    const caller = makeCaller();
    const workerId = crypto.randomUUID();
    const result = await caller.worker.register({
      workerId,
      name: "TestWorker",
      tools: [],
    });
    expect(result.workerId).toBe(workerId);
    expect(connectionRegistry.isConnected(workerId)).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("worker.register duplicate", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "W",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await expect(
      caller.worker.register({ workerId, name: "W2", tools: [] }),
    ).rejects.toThrow("already connected");
    connectionRegistry.unregister(workerId);
  });

  test("worker.rename nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.worker.rename({
        workerId: "550e8400-e29b-41d4-a716-446655440000",
        name: "New",
      }),
    ).rejects.toThrow("not found");
  });

  test("worker.rename success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "OldName",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const result = await caller.worker.rename({ workerId, name: "NewName" });
    expect(result.renamed).toBe(true);
    const worker = connectionRegistry.getWorker(workerId);
    expect(worker!.name).toBe("NewName");
    connectionRegistry.unregister(workerId);
  });

  test("worker.toolResult", async () => {
    const caller = makeCaller();
    const result = await caller.worker.toolResult({
      toolCallId: "tc_unknown",
      result: "value",
    });
    expect(result.received).toBe(false);
  });
});
