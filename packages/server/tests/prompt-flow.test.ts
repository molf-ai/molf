import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";
import type { ProviderState } from "@molf-ai/agent-core";

/**
 * AgentRunner prompt-flow integration test.
 *
 * Mocks the LLM layer (ai + @ai-sdk/google) and exercises
 * AgentRunner.prompt() → Agent → Session → EventBus.
 *
 * The mocked streamText yields pre-baked stream events (including
 * tool-result), so tool execution is simulated entirely within the
 * stream — no actual tool dispatch occurs.
 */

const { SessionManager } = await import("../src/session-mgr.js");
const { ConnectionRegistry } = await import("../src/connection-registry.js");
const { EventBus } = await import("../src/event-bus.js");
const { ToolDispatch } = await import("../src/tool-dispatch.js");
const { UploadDispatch } = await import("../src/upload-dispatch.js");
const { InlineMediaCache } = await import("../src/inline-media-cache.js");
const { AgentRunner } = await import("../src/agent-runner.js");
const { ApprovalGate } = await import("../src/approval/approval-gate.js");
const { RulesetStorage } = await import("../src/approval/ruleset-storage.js");
const { WorkspaceStore } = await import("../src/workspace-store.js");
const { WorkspaceNotifier } = await import("../src/workspace-notifier.js");
const { appRouter } = await import("../src/router.js");
const { initTRPC } = await import("@trpc/server");

import type { ServerContext } from "../src/context.js";

function makeProviderState(): ProviderState {
  const testModel = {
    id: "test",
    providerID: "gemini",
    name: "Test Model",
    api: { id: "test", url: "", npm: "@ai-sdk/google" },
    capabilities: {
      reasoning: false,
      toolcall: true,
      temperature: true,
      input: { text: true, image: false, pdf: false, audio: false, video: false },
      output: { text: true, image: false, pdf: false, audio: false, video: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active" as const,
    headers: {},
    options: {},
  };
  const languageCache = new Map<string, any>();
  languageCache.set("gemini/test", "mock-language-model" as any);
  return {
    providers: {
      gemini: {
        id: "gemini",
        name: "Google Gemini",
        env: ["GEMINI_API_KEY"],
        npm: "@ai-sdk/google",
        source: "env",
        key: "test-key",
        options: {},
        models: { test: testModel },
      },
    },
    sdkCache: new Map(),
    languageCache,
    modelLoaders: {},
  };
}

const t = initTRPC.context<ServerContext>().create();
const createCallerFactory = t.createCallerFactory;

let tmp: TmpDir;
let env: EnvGuard;
let sessionMgr: InstanceType<typeof SessionManager>;
let connectionRegistry: InstanceType<typeof ConnectionRegistry>;
let eventBus: InstanceType<typeof EventBus>;
let toolDispatch: InstanceType<typeof ToolDispatch>;
let uploadDispatch: InstanceType<typeof UploadDispatch>;
let inlineMediaCache: InstanceType<typeof InlineMediaCache>;
let agentRunner: InstanceType<typeof AgentRunner>;
let workspaceStore: InstanceType<typeof WorkspaceStore>;
let workspaceNotifier: InstanceType<typeof WorkspaceNotifier>;

const WORKER_ID = crypto.randomUUID();

function makeCaller() {
  const createCaller = createCallerFactory(appRouter);
  return createCaller({
    token: "test-token",
    clientId: "flow-client",
    sessionMgr,
    connectionRegistry,
    agentRunner,
    eventBus,
    toolDispatch,
    uploadDispatch,
    inlineMediaCache,
    approvalGate: new ApprovalGate(new RulesetStorage(tmp.path), eventBus),
    workspaceStore,
    workspaceNotifier,
    providerState: makeProviderState(),
    dataDir: tmp.path,
  });
}

async function getWsId(): Promise<string> {
  return (await workspaceStore.ensureDefault(WORKER_ID)).id;
}

function collectEvents(sessionId: string): { events: AgentEvent[]; unsub: () => void } {
  const events: AgentEvent[] = [];
  const unsub = eventBus.subscribe(sessionId, (event) => events.push(event));
  return { events, unsub };
}

function waitForEventType(
  events: AgentEvent[],
  type: string,
  timeoutMs = 5_000,
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for "${type}" (got: ${events.map((e) => e.type).join(", ")})`));
      }
      setTimeout(check, 20);
    };
    check();
  });
}

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");

  tmp = createTmpDir("molf-prompt-flow-");
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  uploadDispatch = new UploadDispatch();
  inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  const approvalGate = new ApprovalGate(rulesetStorage, eventBus);
  workspaceStore = new WorkspaceStore(tmp.path);
  workspaceNotifier = new WorkspaceNotifier();
  agentRunner = new AgentRunner(sessionMgr, eventBus, connectionRegistry, toolDispatch, makeProviderState(), "gemini/test", inlineMediaCache, approvalGate, workspaceStore);

  connectionRegistry.registerWorker({
    id: WORKER_ID,
    name: "flow-worker",
    connectedAt: Date.now(),
    tools: [{
      name: "echo",
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    skills: [],
  });
});

afterAll(() => {
  connectionRegistry.unregister(WORKER_ID);
  inlineMediaCache.close();
  tmp.cleanup();
  env.restore();
});

describe("Prompt flow (AgentRunner → Agent with mocked LLM)", () => {
  test("text-only conversation emits content_delta and turn_complete", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello from LLM" },
        { type: "finish", finishReason: "stop" },
      ]));

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });
    const { events, unsub } = collectEvents(session.sessionId);

    await caller.agent.prompt({ sessionId: session.sessionId, text: "Hello" });
    await waitForEventType(events, "turn_complete");
    unsub();

    const contentDeltas = events.filter((e) => e.type === "content_delta");
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);
    expect((contentDeltas[0] as any).delta).toBe("Hello from LLM");

    expect(events.find((e) => e.type === "turn_complete")).toBeTruthy();
  });

  test("single tool call emits tool_call_start and tool_call_end", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: { text: "ping" } },
          { type: "tool-result", toolCallId: "tc1", toolName: "echo", output: { echoed: "ping" } },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Tool completed" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });
    const { events, unsub } = collectEvents(session.sessionId);

    await caller.agent.prompt({ sessionId: session.sessionId, text: "Use echo" });
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(events.filter((e) => e.type === "tool_call_start").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === "tool_call_end").length).toBeGreaterThanOrEqual(1);
  });

  test("multi-step tool loop (2 sequential calls)", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 2) {
        return mockStreamText([
          { type: "tool-call", toolCallId: `tc_m${callCount}`, toolName: "echo", input: { text: `s${callCount}` } },
          { type: "tool-result", toolCallId: `tc_m${callCount}`, toolName: "echo", output: { echoed: `s${callCount}` } },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });
    const { events, unsub } = collectEvents(session.sessionId);

    await caller.agent.prompt({ sessionId: session.sessionId, text: "Use echo twice" });
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(events.filter((e) => e.type === "tool_call_start").length).toBeGreaterThanOrEqual(2);
  });

  test("agent.prompt returns messageId via router", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "router test" },
        { type: "finish", finishReason: "stop" },
      ]));

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });
    const result = await caller.agent.prompt({ sessionId: session.sessionId, text: "hello" });
    expect(result.messageId).toBeTruthy();
    expect(result.messageId).toMatch(/^msg_/);
  });

  test("agent.prompt while busy returns CONFLICT via router", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });

    // First prompt — starts streaming, doesn't finish
    await caller.agent.prompt({ sessionId: session.sessionId, text: "first" });
    await Bun.sleep(50);

    // Second prompt — should get CONFLICT
    try {
      await caller.agent.prompt({ sessionId: session.sessionId, text: "second" });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("already processing");
    }

    // Clean up
    resolveStream();
    await Bun.sleep(100);
  });

  test("session resume preserves message context", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "First response" },
        { type: "finish", finishReason: "stop" },
      ]));

    const caller = makeCaller();
    const session = await caller.session.create({ workerId: WORKER_ID, workspaceId: await getWsId() });

    const { events: e1, unsub: u1 } = collectEvents(session.sessionId);
    await caller.agent.prompt({ sessionId: session.sessionId, text: "First" });
    await waitForEventType(e1, "turn_complete");
    u1();

    const loaded = await caller.session.load({ sessionId: session.sessionId });
    expect(loaded.messages.length).toBeGreaterThanOrEqual(2);

    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Second response" },
        { type: "finish", finishReason: "stop" },
      ]));

    const { events: e2, unsub: u2 } = collectEvents(session.sessionId);
    await caller.agent.prompt({ sessionId: session.sessionId, text: "Second" });
    await waitForEventType(e2, "turn_complete");
    u2();

    const reloaded = await caller.session.load({ sessionId: session.sessionId });
    expect(reloaded.messages.length).toBeGreaterThanOrEqual(4);
  });
});
