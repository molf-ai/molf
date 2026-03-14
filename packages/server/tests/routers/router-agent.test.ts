import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir, flushAsync } from "@molf-ai/test-utils";
import { SessionManager } from "../../src/session-mgr.js";
import { ConnectionRegistry } from "../../src/connection-registry.js";
import { EventBus } from "../../src/event-bus.js";
import { ToolDispatch } from "../../src/tool-dispatch.js";
import { UploadDispatch } from "../../src/upload-dispatch.js";
import { FsDispatch } from "../../src/fs-dispatch.js";
import { InlineMediaCache } from "../../src/inline-media-cache.js";
import { AgentRunner, AgentBusyError } from "../../src/agent-runner.js";
import { appRouter } from "../../src/router.js";
import { createRouterClient } from "@orpc/server";
import type { ServerContext } from "../../src/context.js";
import { ApprovalGate } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { WorkspaceStore } from "../../src/workspace-store.js";
import { WorkspaceNotifier } from "../../src/workspace-notifier.js";
import { makeProviderState } from "../_provider-state.js";

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
  return createRouterClient(appRouter, {
    context: {
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
    } as ServerContext,
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
  uploadDispatch = new UploadDispatch(tmp.path);
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

    // Emit events (flush to let async iterator start listening)
    await flushAsync();
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

    await flushAsync();
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
