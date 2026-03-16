import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { HookRegistry } from "@molf-ai/protocol";
import { makeWorker, ServerBus, ApprovalGate, RulesetStorage } from "./_helpers.js";
import { buildRemoteTools } from "../src/tool-builder.js";
import { ToolDispatch } from "../src/tool-dispatch.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

let tmp: TmpDir;
let env: EnvGuard;
let serverBus: InstanceType<typeof ServerBus>;
let approvalGate: InstanceType<typeof ApprovalGate>;
const WORKER_ID = crypto.randomUUID();
const noopLogger = { warn: () => {} };

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");
  tmp = createTmpDir("molf-tool-builder-hooks-");
  serverBus = new ServerBus();
  const rulesetStorage = new RulesetStorage(tmp.path);
  approvalGate = new ApprovalGate(rulesetStorage, serverBus, false);
});
afterAll(() => { tmp.cleanup(); env.restore(); });

function makeToolDispatchWithAutoResolve() {
  const td = new ToolDispatch();
  return {
    td,
    autoResolve(output: string, extra?: { error?: string; meta?: any }) {
      const ac = new AbortController();
      (async () => {
        for await (const req of td.subscribeWorker(WORKER_ID, ac.signal)) {
          td.resolveToolCall(req.toolCallId, { output, ...extra });
        }
      })();
      return () => ac.abort();
    },
  };
}

function makeToolDispatchCapturing() {
  const td = new ToolDispatch();
  const captured: Array<{ toolCallId: string; toolName: string; args: any }> = [];
  const ac = new AbortController();
  (async () => {
    for await (const req of td.subscribeWorker(WORKER_ID, ac.signal)) {
      captured.push({ toolCallId: req.toolCallId, toolName: req.toolName, args: req.args });
      td.resolveToolCall(req.toolCallId, { output: "ok" });
    }
  })();
  return { td, captured, cleanup: () => ac.abort() };
}

function makeEchoWorker() {
  return makeWorker({
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
  });
}

describe("buildRemoteTools hook integration", () => {
  test("before_tool_call modifies args", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("before_tool_call", "test-plugin", (event) => {
      return { args: { ...event.args, text: "modified-text" } };
    });

    const { td, captured, cleanup } = makeToolDispatchCapturing();
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-modify-args", loadedInstructions: new Set() });

    await tools.echo.execute!({ text: "original" } as any, { toolCallId: "tc-1", abortSignal: undefined } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].args.text).toBe("modified-text");
    cleanup();
  });

  test("before_tool_call blocks tool call", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("before_tool_call", "policy-plugin", () => {
      return { block: "Policy violation" };
    });

    const td = new ToolDispatch();
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-block", loadedInstructions: new Set() });

    const result = await tools.echo.execute!({ text: "hello" } as any, { toolCallId: "tc-block", abortSignal: undefined } as any);
    expect(result).toBe("Tool call blocked by plugin: Policy violation");
  });

  test("before_tool_call error doesn't prevent execution", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("before_tool_call", "broken-plugin", () => {
      throw new Error("plugin crashed");
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("success-output");
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-err", loadedInstructions: new Set() });

    const result = await tools.echo.execute!({ text: "hello" } as any, { toolCallId: "tc-err", abortSignal: undefined } as any);
    expect(result).toBe("success-output");
    cleanup();
  });

  test("before_tool_call receives correct event data", async () => {
    const hookRegistry = new HookRegistry();
    let capturedEvent: any = null;
    hookRegistry.on("before_tool_call", "spy-plugin", (event) => {
      capturedEvent = { ...event };
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("ok");
    const sessionId = "s-event-data";
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId, loadedInstructions: new Set() });

    await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-data", abortSignal: undefined } as any);

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.sessionId).toBe(sessionId);
    expect(capturedEvent.toolCallId).toBe("tc-data");
    expect(capturedEvent.toolName).toBe("echo");
    expect(capturedEvent.args).toEqual({ text: "hi" });
    expect(capturedEvent.workerId).toBe(WORKER_ID);
    cleanup();
  });

  test("after_tool_call modifies output", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("after_tool_call", "transform-plugin", () => {
      return { result: { output: "modified", error: undefined, meta: undefined } };
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("original-output");
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-after-modify", loadedInstructions: new Set() });

    const result = await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-after", abortSignal: undefined } as any);
    expect(result).toBe("modified");
    cleanup();
  });

  test("after_tool_call clears error", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("after_tool_call", "recovery-plugin", () => {
      return { result: { output: "recovered", error: undefined } };
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("", { error: "tool crashed" });
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-clear-err", loadedInstructions: new Set() });

    const result = await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-clear", abortSignal: undefined } as any);
    expect(result).toBe("recovered");
    cleanup();
  });

  test("after_tool_call error preserves original result", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("after_tool_call", "broken-after-plugin", () => {
      throw new Error("after hook crashed");
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("original-output");
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-after-err", loadedInstructions: new Set() });

    const result = await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-after-err", abortSignal: undefined } as any);
    expect(result).toBe("original-output");
    cleanup();
  });

  test("after_tool_call receives correct event data", async () => {
    const hookRegistry = new HookRegistry();
    let capturedEvent: any = null;
    hookRegistry.on("after_tool_call", "spy-after-plugin", (event) => {
      capturedEvent = { ...event };
    });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("the-output");
    const sessionId = "s-after-data";
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId, loadedInstructions: new Set() });

    await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-after-data", abortSignal: undefined } as any);

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.sessionId).toBe(sessionId);
    expect(capturedEvent.toolCallId).toBe("tc-after-data");
    expect(capturedEvent.toolName).toBe("echo");
    expect(capturedEvent.args).toEqual({ text: "hi" });
    expect(capturedEvent.result).toEqual({ output: "the-output", error: undefined, meta: undefined });
    expect(typeof capturedEvent.duration).toBe("number");
    cleanup();
  });

  test("hooks not invoked without sessionCtx", async () => {
    const hookRegistry = new HookRegistry();
    let beforeCalled = false;
    let afterCalled = false;
    hookRegistry.on("before_tool_call", "no-ctx-plugin", () => { beforeCalled = true; });
    hookRegistry.on("after_tool_call", "no-ctx-plugin", () => { afterCalled = true; });

    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("ok");
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    });

    await tools.echo.execute!({ text: "hi" } as any, { toolCallId: "tc-no-ctx", abortSignal: undefined } as any);

    expect(beforeCalled).toBe(false);
    expect(afterCalled).toBe(false);
    cleanup();
  });

  test("multi-plugin chaining on before_tool_call", async () => {
    const hookRegistry = new HookRegistry();
    hookRegistry.on("before_tool_call", "plugin-a", (event) => {
      return { args: { ...event.args, addedByA: true } };
    });
    hookRegistry.on("before_tool_call", "plugin-b", (event) => {
      return { args: { ...event.args, addedByB: true } };
    });

    const { td, captured, cleanup } = makeToolDispatchCapturing();
    const tools = buildRemoteTools(makeEchoWorker(), WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta: new Map(), attachmentMeta: new Map(),
      hookRegistry, hookLogger: noopLogger,
    }, { sessionId: "s-chain", loadedInstructions: new Set() });

    await tools.echo.execute!({ text: "original" } as any, { toolCallId: "tc-chain", abortSignal: undefined } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].args.text).toBe("original");
    expect(captured[0].args.addedByA).toBe(true);
    expect(captured[0].args.addedByB).toBe(true);
    cleanup();
  });
});
