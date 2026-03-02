import { describe, test, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mockStreamText, mockTextResponse } from "@molf-ai/test-utils";
import { setStreamTextImpl, setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";
import type { ProviderState } from "@molf-ai/agent-core";

// --- Dynamic imports (AFTER harness sets up mock.module) ---

const { AgentRunner } = await import("../src/agent-runner.js");
const { SessionManager } = await import("../src/session-mgr.js");
const { ConnectionRegistry } = await import("../src/connection-registry.js");
const { EventBus } = await import("../src/event-bus.js");
const { ToolDispatch } = await import("../src/tool-dispatch.js");
const { InlineMediaCache } = await import("../src/inline-media-cache.js");
const { ApprovalGate } = await import("../src/approval/approval-gate.js");
const { RulesetStorage } = await import("../src/approval/ruleset-storage.js");

import type { WorkerRegistration } from "../src/connection-registry.js";

function makeProviderState(contextWindow = 200_000): ProviderState {
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
    limit: { context: contextWindow, output: 8192 },
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

// --- Test infrastructure ---

let tmp: TmpDir;
let env: EnvGuard;
let sessionMgr: InstanceType<typeof SessionManager>;
let connectionRegistry: InstanceType<typeof ConnectionRegistry>;
let eventBus: InstanceType<typeof EventBus>;
let toolDispatch: InstanceType<typeof ToolDispatch>;
let inlineMediaCache: InstanceType<typeof InlineMediaCache>;
let agentRunner: InstanceType<typeof AgentRunner>;

const WORKER_ID = crypto.randomUUID();

/** Track generateText calls */
let generateTextCallCount = 0;
let generateTextResult = "## Goal\nTest summary\n\n## Key Instructions\nNone\n\n## Progress\nDone\n\n## Key Findings\nNone\n\n## Relevant Files\nNone";
let generateTextShouldThrow = false;

function makeWorker(overrides?: Partial<WorkerRegistration>): WorkerRegistration {
  return {
    role: "worker",
    id: WORKER_ID,
    name: "sum-worker",
    connectedAt: Date.now(),
    tools: [
      {
        name: "echo",
        description: "Echo the input",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
    skills: [],
    ...overrides,
  };
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
        return reject(
          new Error(`Timed out waiting for "${type}" (got: ${events.map((e) => e.type).join(", ")})`),
        );
      }
      setTimeout(check, 20);
    };
    check();
  });
}

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");

  tmp = createTmpDir("molf-summarization-");
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  const approvalGate = new ApprovalGate(rulesetStorage, eventBus);
  agentRunner = new AgentRunner(
    sessionMgr,
    eventBus,
    connectionRegistry,
    toolDispatch,
    makeProviderState(),
    "gemini/test",
    inlineMediaCache,
    approvalGate,
  );

  connectionRegistry.registerWorker(makeWorker());
});

afterAll(async () => {
  connectionRegistry.unregister(WORKER_ID);
  inlineMediaCache.close();
  // Brief delay to let any in-flight async session saves finish before
  // removing the temp directory (summarization writes after turn_complete).
  await Bun.sleep(200);
  tmp.cleanup();
  env.restore();
});

beforeEach(() => {
  generateTextCallCount = 0;
  generateTextResult = "## Goal\nTest summary\n\n## Key Instructions\nNone\n\n## Progress\nDone\n\n## Key Findings\nNone\n\n## Relevant Files\nNone";
  generateTextShouldThrow = false;
  setStreamTextImpl(() => mockTextResponse("default"));
  setGenerateTextImpl(() => {
    generateTextCallCount++;
    if (generateTextShouldThrow) {
      return Promise.reject(new Error("LLM down"));
    }
    return Promise.resolve({ text: generateTextResult });
  });
});

// --- Helper to seed a session with multiple messages ---

function seedSessionMessages(
  sessionId: string,
  count: number,
  opts?: { usage?: { inputTokens: number; outputTokens: number }; summary?: boolean },
): void {
  for (let i = 0; i < count; i++) {
    const now = Date.now();
    sessionMgr.addMessage(sessionId, {
      id: `msg_seed_${now}_${i}`,
      role: "user",
      content: `Question ${i}`,
      timestamp: now,
    });
    sessionMgr.addMessage(sessionId, {
      id: `msg_seed_${now}_${i}_a`,
      role: "assistant",
      content: `Answer ${i}`,
      timestamp: now + 1,
      ...(opts?.usage && i === count - 1 ? { usage: opts.usage } : {}),
      ...(opts?.summary ? { summary: true } : {}),
    });
  }
}

// =============================================================================
// shouldSummarize tests
// =============================================================================

describe("shouldSummarize (via runPrompt)", () => {
  test("context below 80% threshold → no context_compacted event", async () => {
    // Low usage = 10% of default 200k context window
    setStreamTextImpl(() =>
      mockTextResponse("low usage", {
        inputTokens: 20_000,
        outputTokens: 100,
        totalTokens: 20_100,
      }),
    );

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    // Seed enough messages (>= 6)
    seedSessionMessages(session.sessionId, 4);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test low usage");
    await waitForEventType(events, "turn_complete");
    // Give summarization a chance to run
    await Bun.sleep(100);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();
    expect(generateTextCallCount).toBe(0);

    agentRunner.evict(session.sessionId);
  });

  test("context above 80% → context_compacted event emitted", async () => {
    // High usage = 85% of 200k context window
    setStreamTextImpl(() =>
      mockTextResponse("high usage", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    // Seed enough messages (>= 6 total including the prompt we're about to send)
    seedSessionMessages(session.sessionId, 4);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test high usage");
    // Wait for context_compacted (comes after turn_complete)
    await waitForEventType(events, "context_compacted", 5_000);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted") as any;
    expect(compacted).toBeTruthy();
    expect(compacted.summaryMessageId).toBeTruthy();
    expect(generateTextCallCount).toBeGreaterThanOrEqual(1);

    agentRunner.evict(session.sessionId);
  });

  test("less than 6 messages → no summarization", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("few msgs", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    // Only 2 messages + our prompt = 3 total (< 6)
    seedSessionMessages(session.sessionId, 1);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "only a few");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(100);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();

    agentRunner.evict(session.sessionId);
  });

  test("no usage data on messages → no summarization", async () => {
    // Return stream with NO usage (inputTokens/outputTokens undefined)
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "no usage" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({ inputTokens: undefined, outputTokens: undefined }),
    }));

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 4);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "no usage data");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(100);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();

    agentRunner.evict(session.sessionId);
  });

  test("post-summary active window < 6 messages → no summarization", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("post-summary check", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    // Seed many messages so total >= 6 (passing the first check)
    seedSessionMessages(session.sessionId, 5);

    // Add summary pair near the end — active window starts here
    const now = Date.now();
    sessionMgr.addMessage(session.sessionId, {
      id: `msg_sum_u_${now}`,
      role: "user",
      content: "[Summary]",
      timestamp: now,
      synthetic: true,
      summary: true,
    });
    sessionMgr.addMessage(session.sessionId, {
      id: `msg_sum_a_${now}`,
      role: "assistant",
      content: "Summary of everything so far",
      timestamp: now + 1,
      synthetic: true,
      summary: true,
    });
    // No additional messages after summary — active window will be:
    // summary_user + summary_assistant + prompt_user + prompt_assistant = 4 (< 6)

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "after summary");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(100);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();

    agentRunner.evict(session.sessionId);
  });
});

// =============================================================================
// performSummarization tests
// =============================================================================

describe("performSummarization", () => {
  test("successful summarization → two summary messages injected (user + assistant)", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("trigger summary", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "summarize me");
    await waitForEventType(events, "context_compacted", 5_000);
    unsub();

    // Check that summary messages exist in SessionManager
    const msgs = sessionMgr.getMessages(session.sessionId);
    const summaryMsgs = msgs.filter((m) => m.summary === true);

    // Should have at least one user+assistant summary pair
    expect(summaryMsgs.length).toBeGreaterThanOrEqual(2);

    const userSummary = summaryMsgs.find((m) => m.role === "user");
    const assistantSummary = summaryMsgs.find((m) => m.role === "assistant");
    expect(userSummary).toBeTruthy();
    expect(assistantSummary).toBeTruthy();
    expect(userSummary!.synthetic).toBe(true);
    expect(assistantSummary!.synthetic).toBe(true);

    agentRunner.evict(session.sessionId);
  });

  test("summary text < 100 chars → no messages injected", async () => {
    generateTextResult = "Short";

    setStreamTextImpl(() =>
      mockTextResponse("trigger short summary", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "short summary test");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(200);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();

    // No summary messages should have been injected
    const msgs = sessionMgr.getMessages(session.sessionId);
    const summaryMsgs = msgs.filter((m) => m.summary === true);
    expect(summaryMsgs.length).toBe(0);

    agentRunner.evict(session.sessionId);
  });

  test("generateText throws → no crash, no event, returns normally", async () => {
    generateTextShouldThrow = true;

    setStreamTextImpl(() =>
      mockTextResponse("trigger crash summary", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "crash test");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(200);
    unsub();

    // Should NOT have emitted context_compacted (generateText failed)
    const compacted = events.find((e) => e.type === "context_compacted");
    expect(compacted).toBeUndefined();

    // Should NOT have emitted an error event (summarization failures are silent)
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(0);

    agentRunner.evict(session.sessionId);
  });

  test("emits context_compacted event with correct summaryMessageId", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("check event id", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "event id test");
    await waitForEventType(events, "context_compacted", 5_000);
    unsub();

    const compacted = events.find((e) => e.type === "context_compacted") as any;
    expect(compacted).toBeTruthy();
    expect(compacted.summaryMessageId).toMatch(/^msg_/);

    // The summaryMessageId should match the assistant summary message in the session
    const msgs = sessionMgr.getMessages(session.sessionId);
    const assistantSummary = msgs.find((m) => m.summary && m.role === "assistant");
    expect(assistantSummary).toBeTruthy();
    expect(compacted.summaryMessageId).toBe(assistantSummary!.id);

    agentRunner.evict(session.sessionId);
  });
});

// =============================================================================
// runPrompt integration tests
// =============================================================================

describe("runPrompt integration", () => {
  test("usage field is persisted on assistant messages", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("usage persist", {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
      }),
    );

    const session = await sessionMgr.create({ workerId: WORKER_ID });

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "persist usage");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
    unsub();

    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded).toBeTruthy();
    const assistantMsgs = loaded!.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect(lastAssistant.usage).toBeTruthy();
    expect(lastAssistant.usage!.inputTokens).toBe(500);
    expect(lastAssistant.usage!.outputTokens).toBe(100);

    agentRunner.evict(session.sessionId);
  });

  test("cache and reasoning token fields are persisted", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("cache test", {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        reasoningTokens: 50,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
      }),
    );

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test cache tokens");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
    unsub();

    const loaded = sessionMgr.load(session.sessionId)!;
    const assistant = loaded.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(assistant.usage).toBeTruthy();
    expect(assistant.usage!.inputTokens).toBe(1000);
    expect(assistant.usage!.outputTokens).toBe(200);
    expect(assistant.usage!.reasoningTokens).toBe(50);
    expect(assistant.usage!.cacheReadTokens).toBe(300);
    expect(assistant.usage!.cacheWriteTokens).toBe(100);

    agentRunner.evict(session.sessionId);
  });

  test("summarization runs at end of turn when threshold exceeded", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("trigger end-of-turn summary", {
        inputTokens: 170_000,
        outputTokens: 1_000,
        totalTokens: 171_000,
      }),
    );

    const session = await sessionMgr.create({
      workerId: WORKER_ID,
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "trigger end of turn");

    // turn_complete should come first
    await waitForEventType(events, "turn_complete");
    // context_compacted should come after
    await waitForEventType(events, "context_compacted", 5_000);
    unsub();

    const eventTypes = events.map((e) => e.type);
    const turnIdx = eventTypes.indexOf("turn_complete");
    const compactIdx = eventTypes.indexOf("context_compacted");
    expect(turnIdx).toBeLessThan(compactIdx);

    agentRunner.evict(session.sessionId);
  });
});
