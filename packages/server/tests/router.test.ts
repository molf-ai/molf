import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../src/session-mgr.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { EventBus } from "../src/event-bus.js";
import { ToolDispatch } from "../src/tool-dispatch.js";
import { UploadDispatch } from "../src/upload-dispatch.js";
import { FsDispatch } from "../src/fs-dispatch.js";
import { InlineMediaCache } from "../src/inline-media-cache.js";
import { AgentRunner } from "../src/agent-runner.js";
import { appRouter } from "../src/router.js";
import { initTRPC } from "@trpc/server";
import type { ServerContext } from "../src/context.js";
import { ApprovalGate } from "../src/approval/approval-gate.js";
import { RulesetStorage } from "../src/approval/ruleset-storage.js";
import { WorkspaceStore } from "../src/workspace-store.js";
import { WorkspaceNotifier } from "../src/workspace-notifier.js";
import { makeProviderState } from "./_provider-state.js";

const t = initTRPC.context<ServerContext>().create();
const createCallerFactory = t.createCallerFactory;

let tmp: TmpDir;
let sessionMgr: SessionManager;
let connectionRegistry: ConnectionRegistry;
let eventBus: EventBus;
let toolDispatch: ToolDispatch;
let uploadDispatch: UploadDispatch;
let fsDispatch: FsDispatch;
let inlineMediaCache: InlineMediaCache;
let agentRunner: AgentRunner;
let approvalGate: ApprovalGate;
let workspaceStore: WorkspaceStore;
let workspaceNotifier: WorkspaceNotifier;

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
    uploadDispatch,
    fsDispatch,
    inlineMediaCache,
    approvalGate,
    workspaceStore,
    workspaceNotifier,
    providerState: makeProviderState(),
    dataDir: tmp.path,
  });
}

async function getWsId(workerId: string): Promise<string> {
  return (await workspaceStore.ensureDefault(workerId)).id;
}

beforeAll(() => {
  tmp = createTmpDir();
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  uploadDispatch = new UploadDispatch();
  fsDispatch = new FsDispatch();
  inlineMediaCache = new InlineMediaCache();
  approvalGate = new ApprovalGate(new RulesetStorage(tmp.path), eventBus);
  workspaceStore = new WorkspaceStore(tmp.path);
  workspaceNotifier = new WorkspaceNotifier();
  agentRunner = new AgentRunner(sessionMgr, eventBus, connectionRegistry, toolDispatch, makeProviderState(), "gemini/test", inlineMediaCache, approvalGate, workspaceStore);
});

afterAll(() => {
  inlineMediaCache.close();
  tmp.cleanup();
});

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
    const result = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    expect(result.sessionId).toBeTruthy();
    expect(result.workerId).toBe(workerId);
    connectionRegistry.unregister(workerId);
  });

  test("session.create with nonexistent worker", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.create({ workerId: "550e8400-e29b-41d4-a716-446655440000", workspaceId: await getWsId("550e8400-e29b-41d4-a716-446655440000") }),
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
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
    await caller.session.create({ workerId: workerIdA, workspaceId: await getWsId(workerIdA) });
    await caller.session.create({ workerId: workerIdA, workspaceId: await getWsId(workerIdA) });
    await caller.session.create({ workerId: workerIdB, workspaceId: await getWsId(workerIdB) });

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
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "telegram", chatId: 100 } });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "telegram", chatId: 200 } });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "tui" } });

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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    toolDispatch.resolveToolCall("tc_sub_1", { output: "done" });
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    // Disconnect the worker
    connectionRegistry.unregister(workerId);
    await expect(
      caller.agent.prompt({ sessionId: created.sessionId, text: "hello" }),
    ).rejects.toThrow("disconnected");
  });
});

describe("agent.shellExec", () => {
  function withShellExecWorker(fn: (workerId: string, sessionId: string) => Promise<void>) {
    return async () => {
      const workerId = crypto.randomUUID();
      connectionRegistry.registerWorker({
        id: workerId,
        name: "ShellWorker",
        connectedAt: Date.now(),
        tools: [{ name: "shell_exec", description: "Execute shell command", inputSchema: {} }],
        skills: [],
      });
      const caller = makeCaller();
      const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
      try {
        await fn(workerId, created.sessionId);
      } finally {
        connectionRegistry.unregister(workerId);
      }
    };
  }

  test("session not found → NOT_FOUND", async () => {
    const caller = makeCaller();
    await expect(
      caller.agent.shellExec({ sessionId: "nonexistent", command: "echo hi" }),
    ).rejects.toThrow("Session nonexistent not found");
  });

  test("worker not connected → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [{ name: "shell_exec", description: "Execute shell command", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    connectionRegistry.unregister(workerId);

    await expect(
      caller.agent.shellExec({ sessionId: created.sessionId, command: "echo hi" }),
    ).rejects.toThrow("Worker not connected");
  });

  test("worker missing shell_exec tool → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "NoShellWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    try {
      await expect(
        caller.agent.shellExec({ sessionId: created.sessionId, command: "echo hi" }),
      ).rejects.toThrow("Worker does not support shell_exec");
    } finally {
      connectionRegistry.unregister(workerId);
    }
  });

  test(
    "dispatch error (non-disconnect) → INTERNAL_SERVER_ERROR",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({ output: "", error: "Something went wrong" });
      try {
        const caller = makeCaller();
        await expect(
          caller.agent.shellExec({ sessionId, command: "echo hi" }),
        ).rejects.toThrow("Something went wrong");
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "worker disconnected mid-dispatch → PRECONDITION_FAILED",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "",
        error: `Worker ${workerId} disconnected`,
      });
      try {
        const caller = makeCaller();
        await expect(
          caller.agent.shellExec({ sessionId, command: "echo hi" }),
        ).rejects.toThrow("disconnected");
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "success → returns output, exitCode, and truncated flag",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "hello\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        const result = await caller.agent.shellExec({ sessionId, command: "echo hello" });
        expect(result.output).toBe("hello\n\n\nexit code: 0");
        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(false);
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
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
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    connectionRegistry.unregister(workerId);
    const result = await caller.tool.list({ sessionId: created.sessionId });
    expect(result.tools).toEqual([]);
  });

  test("tool.approve with unknown approvalId returns applied=false", async () => {
    const caller = makeCaller();
    const result = await caller.tool.approve({ sessionId: "s1", approvalId: "nonexistent" });
    expect(result.applied).toBe(false);
  });

  test("tool.approve with always=true returns applied=false for unknown approvalId", async () => {
    const caller = makeCaller();
    const result = await caller.tool.approve({ sessionId: "s1", approvalId: "nonexistent", always: true });
    expect(result.applied).toBe(false);
  });

  test("tool.deny with unknown approvalId returns applied=false", async () => {
    const caller = makeCaller();
    const result = await caller.tool.deny({ sessionId: "s1", approvalId: "nonexistent" });
    expect(result.applied).toBe(false);
  });

  test("tool.deny with feedback returns applied=false for unknown approvalId", async () => {
    const caller = makeCaller();
    const result = await caller.tool.deny({
      sessionId: "s1",
      approvalId: "nonexistent",
      feedback: "Don't do that",
    });
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

  test("worker.register duplicate replaces stale connection", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "W",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    // Re-registration should succeed (stale cleanup)
    const result = await caller.worker.register({ workerId, name: "W2", tools: [] });
    expect(result.workerId).toBe(workerId);
    // New registration should have the updated name
    const worker = connectionRegistry.getWorker(workerId);
    expect(worker?.name).toBe("W2");
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
      output: "value",
    });
    expect(result.received).toBe(false);
  });

  test("worker.toolResult with truncation fields", async () => {
    const caller = makeCaller();
    // Set up a pending dispatch so resolveToolCall returns true
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TruncWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const dispatchPromise = toolDispatch.dispatch(workerId, {
      toolCallId: "tc_trunc_1",
      toolName: "echo",
      args: {},
    });

    const result = await caller.worker.toolResult({
      toolCallId: "tc_trunc_1",
      output: "truncated content",
      meta: { truncated: true, outputId: "tc_trunc_1" },
    });
    expect(result.received).toBe(true);

    const dispatchResult = await dispatchPromise;
    expect(dispatchResult.meta?.truncated).toBe(true);
    expect(dispatchResult.meta?.outputId).toBe("tc_trunc_1");

    connectionRegistry.unregister(workerId);
  });

  test("worker.fsReadResult resolves a pending fs read", async () => {
    const caller = makeCaller();
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });

    const dispatchPromise = fsDispatch.dispatch(workerId, {
      requestId: "fs_test_1",
      outputId: "out_1",
    });

    const result = await caller.worker.fsReadResult({
      requestId: "fs_test_1",
      content: "file content here",
      size: 17,
      encoding: "utf-8",
    });
    expect(result.received).toBe(true);

    const fsResult = await dispatchPromise;
    expect(fsResult.content).toBe("file content here");
    expect(fsResult.size).toBe(17);
    expect(fsResult.encoding).toBe("utf-8");

    connectionRegistry.unregister(workerId);
  });
});

describe("agent.shellExec with saveToSession", () => {
  function withShellExecWorker(fn: (workerId: string, sessionId: string) => Promise<void>) {
    return async () => {
      const workerId = crypto.randomUUID();
      connectionRegistry.registerWorker({
        id: workerId,
        name: "ShellSaveWorker",
        connectedAt: Date.now(),
        tools: [{ name: "shell_exec", description: "Execute shell command", inputSchema: {} }],
        skills: [],
      });
      const caller = makeCaller();
      const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
      try {
        await fn(workerId, created.sessionId);
      } finally {
        connectionRegistry.unregister(workerId);
      }
    };
  }

  test(
    "saveToSession: true injects synthetic messages into session",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "file1.txt\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        const result = await caller.agent.shellExec({
          sessionId,
          command: "ls",
          saveToSession: true,
        });
        expect(result.output).toContain("file1.txt");
        expect(result.exitCode).toBe(0);

        // Verify synthetic messages were injected
        const loaded = sessionMgr.load(sessionId);
        expect(loaded).toBeTruthy();
        const msgs = loaded!.messages;
        expect(msgs.length).toBe(3);
        expect(msgs[0].role).toBe("user");
        expect(msgs[0].synthetic).toBe(true);
        expect(msgs[0].content).toContain("executed by the user");
        expect(msgs[1].role).toBe("assistant");
        expect(msgs[1].synthetic).toBe(true);
        expect(msgs[1].toolCalls).toHaveLength(1);
        expect(msgs[1].toolCalls![0].toolName).toBe("shell_exec");
        expect(msgs[1].toolCalls![0].args).toEqual({ command: "ls" });
        expect(msgs[2].role).toBe("tool");
        expect(msgs[2].synthetic).toBe(true);
        expect(msgs[2].toolName).toBe("shell_exec");
        expect(msgs[2].content).toContain("file1.txt");
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession: false does NOT inject messages",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "file1.txt\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        await caller.agent.shellExec({
          sessionId,
          command: "ls",
          saveToSession: false,
        });

        const loaded = sessionMgr.load(sessionId);
        expect(loaded!.messages.length).toBe(0);
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession: true while agent busy → CONFLICT",
    withShellExecWorker(async (workerId, sessionId) => {
      // Mock agent as busy
      const origGetStatus = agentRunner.getStatus.bind(agentRunner);
      (agentRunner as any).getStatus = () => "streaming";
      try {
        const caller = makeCaller();
        await expect(
          caller.agent.shellExec({ sessionId, command: "ls", saveToSession: true }),
        ).rejects.toThrow("Agent is busy");
      } finally {
        (agentRunner as any).getStatus = origGetStatus;
      }
    }),
  );

  test(
    "saveToSession: false while agent busy → executes normally",
    withShellExecWorker(async (workerId, sessionId) => {
      const origGetStatus = agentRunner.getStatus.bind(agentRunner);
      (agentRunner as any).getStatus = () => "streaming";
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "ok\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        const result = await caller.agent.shellExec({
          sessionId,
          command: "echo ok",
          saveToSession: false,
        });
        expect(result.output).toContain("ok");
        expect(result.exitCode).toBe(0);
      } finally {
        (agentRunner as any).getStatus = origGetStatus;
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession omitted defaults to no injection",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "file1.txt\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        await caller.agent.shellExec({ sessionId, command: "ls" });

        const loaded = sessionMgr.load(sessionId);
        expect(loaded!.messages.length).toBe(0);
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession: true skips injection if agent became busy during dispatch (race guard)",
    withShellExecWorker(async (workerId, sessionId) => {
      let callCount = 0;
      const origGetStatus = agentRunner.getStatus.bind(agentRunner);
      // First call returns idle (pre-dispatch guard), second call returns streaming (post-dispatch guard)
      (agentRunner as any).getStatus = (sid: string) => {
        callCount++;
        return callCount <= 1 ? "idle" : "streaming";
      };
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: "ok\n\n\nexit code: 0",
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        const result = await caller.agent.shellExec({
          sessionId,
          command: "ls",
          saveToSession: true,
        });
        // Shell result is still returned to client
        expect(result.output).toContain("ok");
        // But session should have NO injected messages (skipped due to race)
        const loaded = sessionMgr.load(sessionId);
        expect(loaded!.messages.length).toBe(0);
      } finally {
        (agentRunner as any).getStatus = origGetStatus;
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession: true skips injection when session deleted during dispatch [P3-F15]",
    withShellExecWorker(async (workerId, sessionId) => {
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => {
        // Simulate session deletion during dispatch
        sessionMgr.delete(sessionId);
        return {
          output: "ok\n\n\nexit code: 0",
          meta: {
            truncated: false,
            exitCode: 0,
          },
        };
      };
      try {
        const caller = makeCaller();
        const result = await caller.agent.shellExec({
          sessionId,
          command: "ls",
          saveToSession: true,
        });
        // Command result still returned to caller
        expect(result.output).toContain("ok");
        // Session was deleted, so load should return null (no crash)
        expect(sessionMgr.load(sessionId)).toBeNull();
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );

  test(
    "saveToSession: true injects worker output as-is (no re-truncation)",
    withShellExecWorker(async (workerId, sessionId) => {
      // Simulate output already truncated by the worker
      const bigOutput = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
      const origDispatch = toolDispatch.dispatch.bind(toolDispatch);
      (toolDispatch as any).dispatch = async () => ({
        output: `${bigOutput}\n\nexit code: 0`,
        meta: {
          truncated: false,
          exitCode: 0,
        },
      });
      try {
        const caller = makeCaller();
        await caller.agent.shellExec({
          sessionId,
          command: "big-cmd",
          saveToSession: true,
        });

        const loaded = sessionMgr.load(sessionId);
        expect(loaded!.messages.length).toBe(3);
        const toolMsg = loaded!.messages[2];
        // Full worker output should be injected without re-truncation
        expect(toolMsg.content).toContain("line-0");
        expect(toolMsg.content).toContain("line-2999");
        expect(toolMsg.content).toContain("exit code: 0");
      } finally {
        (toolDispatch as any).dispatch = origDispatch;
      }
    }),
  );
});

describe("fs.read", () => {
  test("session not found → NOT_FOUND", async () => {
    const caller = makeCaller();
    await expect(
      caller.fs.read({ sessionId: "nonexistent", outputId: "out1" }),
    ).rejects.toThrow("Session nonexistent not found");
  });

  test("worker not connected → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    connectionRegistry.unregister(workerId);

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "out1" }),
    ).rejects.toThrow("Worker not connected");
  });

  test("happy path: dispatches to worker and returns content", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    // Set up worker subscription to auto-resolve fs reads
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "full file content here",
          size: 22,
          encoding: "utf-8",
        });
      }
    })();

    const result = await caller.fs.read({
      sessionId: created.sessionId,
      outputId: "out_test",
    });

    expect(result.content).toBe("full file content here");
    expect(result.size).toBe(22);
    expect(result.encoding).toBe("utf-8");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });

  test("worker returns error → INTERNAL_SERVER_ERROR", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsErrorWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "",
          size: 0,
          encoding: "utf-8",
          error: "File not found",
        });
      }
    })();

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "missing" }),
    ).rejects.toThrow("File not found");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });

  test("worker disconnect during read → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsDisconnectWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "",
          size: 0,
          encoding: "utf-8",
          error: `Worker ${workerId} disconnected`,
        });
      }
    })();

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "out1" }),
    ).rejects.toThrow("disconnected");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });
});
