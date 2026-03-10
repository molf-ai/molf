import { describe, test, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mockStreamText, mockTextResponse, waitUntil } from "@molf-ai/test-utils";
import type { AgentEvent, SessionMessage } from "@molf-ai/protocol";
import {
  setStreamTextImpl,
  setGenerateTextImpl,
  collectEvents as _collectEvents,
  waitForEventType,
  createTestHarness,
  type TestHarness,
} from "./_helpers.js";
import { findSummaryAnchor } from "../src/summarization.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// --- Test infrastructure ---

let h: TestHarness;
let sessionMgr: TestHarness["sessionMgr"];
let connectionRegistry: TestHarness["connectionRegistry"];
let eventBus: TestHarness["eventBus"];
let agentRunner: TestHarness["agentRunner"];
let WORKER_ID: string;

/** Track generateText calls */
let generateTextCallCount = 0;
let generateTextResult = "## Goal\nTest summary\n\n## Key Instructions\nNone\n\n## Progress\nDone\n\n## Key Findings\nNone\n\n## Relevant Files\nNone";
let generateTextShouldThrow = false;

function collectEvents(sessionId: string) {
  return _collectEvents(eventBus, sessionId);
}

beforeAll(() => {
  h = createTestHarness({ tmpPrefix: "molf-summarization-" });
  ({ sessionMgr, connectionRegistry, eventBus, agentRunner } = h);
  WORKER_ID = h.workerId;
});

afterAll(() => h.cleanup());

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
// findSummaryAnchor unit tests
// =============================================================================

function msg(role: "user" | "assistant", opts?: { summary?: boolean }): SessionMessage {
  return {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    role,
    content: "test",
    timestamp: Date.now(),
    ...(opts?.summary && { summary: true }),
  };
}

describe("findSummaryAnchor", () => {
  test("empty messages → returns 0", () => {
    expect(findSummaryAnchor([])).toBe(0);
  });

  test("no summaries → returns 0", () => {
    const msgs = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
    expect(findSummaryAnchor(msgs)).toBe(0);
  });

  test("single assistant summary at end → returns its index", () => {
    // No user summary before it — returns the assistant index itself
    const msgs = [msg("user"), msg("assistant"), msg("assistant", { summary: true })];
    expect(findSummaryAnchor(msgs)).toBe(2);
  });

  test("user+assistant summary pair → returns user message index", () => {
    const msgs = [
      msg("user"),
      msg("assistant"),
      msg("user", { summary: true }),    // index 2
      msg("assistant", { summary: true }), // index 3
      msg("user"),
      msg("assistant"),
    ];
    expect(findSummaryAnchor(msgs)).toBe(2);
  });

  test("multiple summary pairs → returns anchor of the last pair", () => {
    const msgs = [
      msg("user", { summary: true }),      // index 0 — first pair
      msg("assistant", { summary: true }), // index 1
      msg("user"),
      msg("assistant"),
      msg("user", { summary: true }),      // index 4 — second pair
      msg("assistant", { summary: true }), // index 5
      msg("user"),
      msg("assistant"),
    ];
    expect(findSummaryAnchor(msgs)).toBe(4);
  });
});

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

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    // Seed enough messages (>= 6)
    seedSessionMessages(session.sessionId, 4);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test low usage");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
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
      workspaceId: "test-ws",
    });
    // Only 2 messages + our prompt = 3 total (< 6)
    seedSessionMessages(session.sessionId, 1);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "only a few");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
    });
    seedSessionMessages(session.sessionId, 4);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "no usage data");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
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
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
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
      workspaceId: "test-ws",
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "short summary test");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
    });
    seedSessionMessages(session.sessionId, 5);

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "crash test");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
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

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "persist usage");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test cache tokens");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
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
      workspaceId: "test-ws",
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
