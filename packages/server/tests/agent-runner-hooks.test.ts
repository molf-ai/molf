import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
import { mockTextResponse, waitUntil, flushAsync } from "@molf-ai/test-utils";
import { HookRegistry } from "@molf-ai/protocol";
import type { AgentEvent } from "@molf-ai/protocol";
import {
  setStreamTextImpl,
  SessionManager,
  ConnectionRegistry,
  EventBus,
  ToolDispatch,
  InlineMediaCache,
  ApprovalGate,
  RulesetStorage,
  AgentRunner,
  WorkspaceStore,
  makeProviderState,
  collectEvents as _collectEvents,
  waitForEventType,
} from "./_helpers.js";
import { createEnvGuard, createTmpDir, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let tmp: TmpDir;
let env: EnvGuard;
let registry: HookRegistry;
let sessionMgr: InstanceType<typeof SessionManager>;
let eventBus: InstanceType<typeof EventBus>;
let connectionRegistry: InstanceType<typeof ConnectionRegistry>;
let agentRunner: InstanceType<typeof AgentRunner>;
let inlineMediaCache: InstanceType<typeof InlineMediaCache>;
let WORKER_ID: string;

function collectEvents(sessionId: string) {
  return _collectEvents(eventBus, sessionId);
}

beforeEach(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");
  tmp = createTmpDir("molf-ar-hooks-");

  registry = new HookRegistry();
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  const toolDispatch = new ToolDispatch();
  inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  const approvalGate = new ApprovalGate(rulesetStorage, eventBus);
  const workspaceStore = new WorkspaceStore(tmp.path);
  WORKER_ID = crypto.randomUUID();

  const pluginLoaderLike = {
    hookRegistry: registry,
    hookLogger: { warn: () => {} },
    pluginTools: [],
    sessionToolFactories: [],
  };

  agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(), "gemini/test",
    inlineMediaCache, approvalGate, workspaceStore,
    pluginLoaderLike as any,
  );

  connectionRegistry.registerWorker({
    id: WORKER_ID,
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [{
      name: "echo",
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    skills: [],
    agents: [],
  });

  setStreamTextImpl(() => mockTextResponse("hook test response"));
});

afterEach(async () => {
  inlineMediaCache.close();
  await flushAsync();
  tmp.cleanup();
  env.restore();
});

// ---------------------------------------------------------------------------
// turn_start hook
// ---------------------------------------------------------------------------

describe("turn_start hook", () => {
  test("fires with sessionId, prompt, and model", async () => {
    const calls: unknown[] = [];
    registry.on("turn_start", "test-plugin", (data) => {
      calls.push(data);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "hello hooks");
    await waitForEventType(events, "turn_complete");
    // Observing hooks are fire-and-forget — wait for async settlement
    await flushAsync();

    expect(calls).toHaveLength(1);
    const data = calls[0] as any;
    expect(data.sessionId).toBe(session.sessionId);
    expect(data.prompt).toBe("hello hooks");
    expect(data.model).toContain("gemini");
  });
});

// ---------------------------------------------------------------------------
// before_prompt hook
// ---------------------------------------------------------------------------

describe("before_prompt hook", () => {
  test("can modify systemPrompt (cached session)", async () => {
    // The before_prompt hook's systemPrompt modification is only applied
    // via setSystemPrompt on cached sessions (second prompt onward).
    // First prompt: agent is constructed with original system prompt.
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events: warmupEvents } = collectEvents(session.sessionId);

    // First prompt — populate the cache
    await agentRunner.prompt(session.sessionId, "warmup");
    await waitForEventType(warmupEvents, "turn_complete");

    // Now register the hook and prompt again on the cached session
    let capturedSystem: string | undefined;
    setStreamTextImpl((opts: any) => {
      capturedSystem = opts.system;
      return mockTextResponse("ok");
    });

    registry.on("before_prompt", "test-plugin", () => {
      return { systemPrompt: "CUSTOM SYSTEM PROMPT" };
    });

    // Collect fresh events for the second prompt
    const { events: secondEvents } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test prompt");
    await waitForEventType(secondEvents, "turn_complete");

    expect(capturedSystem).toContain("CUSTOM SYSTEM PROMPT");
  });

  test("can filter tools to an empty set", async () => {
    let capturedTools: Record<string, unknown> | undefined;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockTextResponse("no tools");
    });

    registry.on("before_prompt", "test-plugin", (data) => {
      return { tools: [] };
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "should have no tools");
    await waitForEventType(events, "turn_complete");

    // All remote tools should have been removed
    const toolNames = Object.keys(capturedTools ?? {});
    expect(toolNames).not.toContain("echo");
  });

  test("can modify messages", async () => {
    registry.on("before_prompt", "test-plugin", (data: any) => {
      // Return a modified messages array (different reference)
      return { messages: [...data.messages, { id: "injected", role: "user", content: "injected", timestamp: Date.now() }] };
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "modify messages test");
    await waitForEventType(events, "turn_complete");

    // Verify the injected message ended up in the session
    const messages = sessionMgr.getMessages(session.sessionId);
    const injected = messages.find((m: any) => m.id === "injected");
    expect(injected).toBeDefined();
  });

  test("handler error does not prevent prompt from completing", async () => {
    registry.on("before_prompt", "bad-plugin", () => {
      throw new Error("hook explosion");
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "should still work");
    const turnComplete = await waitForEventType(events, "turn_complete");
    expect(turnComplete).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// after_prompt hook
// ---------------------------------------------------------------------------

describe("after_prompt hook", () => {
  test("fires with response content, usage, and duration", async () => {
    const calls: unknown[] = [];
    registry.on("after_prompt", "test-plugin", (data) => {
      calls.push(data);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "after prompt test");
    await waitForEventType(events, "turn_complete");
    await flushAsync();

    expect(calls).toHaveLength(1);
    const data = calls[0] as any;
    expect(data.sessionId).toBe(session.sessionId);
    expect(data.response).toBeDefined();
    expect(data.response.content).toBe("hook test response");
    expect(data.usage).toBeDefined();
    expect(typeof data.usage.inputTokens).toBe("number");
    expect(typeof data.usage.outputTokens).toBe("number");
    expect(typeof data.duration).toBe("number");
    expect(data.duration).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// turn_end hook
// ---------------------------------------------------------------------------

describe("turn_end hook", () => {
  test("fires with correct shape (no tool calls)", async () => {
    const calls: unknown[] = [];
    registry.on("turn_end", "test-plugin", (data) => {
      calls.push(data);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "turn end test");
    await waitForEventType(events, "turn_complete");
    await flushAsync();

    expect(calls).toHaveLength(1);
    const data = calls[0] as any;
    expect(data.sessionId).toBe(session.sessionId);
    expect(data.message).toBeDefined();
    expect(data.message.role).toBe("assistant");
    expect(data.message.content).toBe("hook test response");
    expect(data.toolCallCount).toBe(0);
    expect(data.stepCount).toBe(1);
    expect(typeof data.duration).toBe("number");
    expect(data.duration).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// No pluginLoader — hooks should not fire
// ---------------------------------------------------------------------------

describe("without pluginLoader", () => {
  test("hooks are not dispatched", async () => {
    // Create a separate AgentRunner without pluginLoader
    const separateRegistry = new HookRegistry();
    const calls: unknown[] = [];
    separateRegistry.on("turn_start", "ghost", (data) => calls.push(data));
    separateRegistry.on("turn_end", "ghost", (data) => calls.push(data));

    const noPluginRunner = new AgentRunner(
      sessionMgr, eventBus, connectionRegistry, new ToolDispatch(),
      makeProviderState(), "gemini/test",
      inlineMediaCache, new ApprovalGate(new RulesetStorage(tmp.path), eventBus),
      new WorkspaceStore(tmp.path),
      // no pluginLoader argument
    );

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "ws" });
    const { events } = collectEvents(session.sessionId);

    await noPluginRunner.prompt(session.sessionId, "no hooks");
    await waitForEventType(events, "turn_complete");
    await flushAsync();

    // The separate registry's handlers should never have been called
    expect(calls).toHaveLength(0);
  });
});
