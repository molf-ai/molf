import { vi, describe, test, expect, beforeEach, afterEach } from "vitest"; 
import { createEnvGuard, createTmpDir, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { HookRegistry } from "@molf-ai/protocol";
import { setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { performSummarization } from "../src/summarization.js";
import { SessionManager } from "../src/session-mgr.js";
import { EventBus } from "../src/event-bus.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOD_SUMMARY =
  "## Goal\nTest summary text for hooks\n\n## Key Instructions\nNone applicable\n\n## Progress\nCompleted several tasks\n\n## Key Findings\nImportant finding about the system\n\n## Relevant Files\nfile.ts";

const noopLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let tmp: TmpDir;
let env: EnvGuard;
let sessionMgr: InstanceType<typeof SessionManager>;
let eventBus: InstanceType<typeof EventBus>;
let hookRegistry: HookRegistry;
let generateTextCalled: boolean;

beforeEach(() => {
  env = createEnvGuard();
  tmp = createTmpDir("molf-sum-hooks-");
  sessionMgr = new SessionManager(tmp.path);
  eventBus = new EventBus();
  hookRegistry = new HookRegistry();
  generateTextCalled = false;
  setGenerateTextImpl(() => {
    generateTextCalled = true;
    return Promise.resolve({ text: GOOD_SUMMARY });
  });
});

afterEach(() => {
  tmp.cleanup();
  env.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed enough user/assistant pairs so performSummarization has messages to compact. */
function seedMessages(sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const ts = Date.now() + i * 2;
    sessionMgr.addMessage(sessionId, {
      id: `msg_u_${ts}_${i}`,
      role: "user",
      content: `User message ${i}`,
      timestamp: ts,
    });
    sessionMgr.addMessage(sessionId, {
      id: `msg_a_${ts}_${i}`,
      role: "assistant",
      content: `Assistant reply ${i}`,
      timestamp: ts + 1,
    });
  }
}

/**
 * Create a session, seed it with message pairs, and return a duck-typed CachedSession.
 * With 10 pairs (20 messages) and KEEP_RECENT_TURNS=4, the cutoff leaves the last
 * 4 user turns and summarizes the rest.
 */
async function createSeededSession(pairCount = 10) {
  const session = await sessionMgr.create({ workerId: "w1", workspaceId: "ws1" });
  seedMessages(session.sessionId, pairCount);
  const activeSession = {
    sessionId: session.sessionId,
    summarizing: false,
    lastResolvedModel: {
      language: "mock-language-model" as any,
      info: {
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
        limit: { context: 200_000, output: 8192 },
        status: "active" as const,
        headers: {},
        options: {},
      },
    },
    loadedInstructions: new Set<string>(),
    agent: null as any,
    workerId: "w1",
    status: "idle" as const,
    lastActiveAt: Date.now(),
    evictionTimer: null,
  };
  return { sessionId: session.sessionId, activeSession };
}

function callPerformSummarization(
  activeSession: Awaited<ReturnType<typeof createSeededSession>>["activeSession"],
  opts?: { hookLogger?: { warn: (msg: string, props?: Record<string, unknown>) => void } },
) {
  return performSummarization(activeSession as any, {
    sessionMgr,
    eventBus,
    getAgentSession: () => undefined,
    hookRegistry,
    hookLogger: opts?.hookLogger ?? noopLogger,
  });
}

// =============================================================================
// before_compaction hook tests
// =============================================================================

describe("before_compaction hook", () => {
  test("blocks compaction when handler returns { block }", async () => {
    const { sessionId, activeSession } = await createSeededSession();

    hookRegistry.on("before_compaction", "test-plugin", () => ({
      block: "Not now",
    }));

    const events: any[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    await callPerformSummarization(activeSession);

    unsub();

    expect(generateTextCalled).toBe(false);
    expect(events.find((e) => e.type === "context_compacted")).toBeUndefined();
    // summarizing flag should be reset
    expect(activeSession.summarizing).toBe(false);
  });

  test("receives correct data (sessionId, messages, reason)", async () => {
    const { sessionId, activeSession } = await createSeededSession();
    let capturedData: any = null;

    hookRegistry.on("before_compaction", "test-plugin", (data) => {
      capturedData = data;
    });

    await callPerformSummarization(activeSession);

    expect(capturedData).not.toBeNull();
    expect(capturedData.sessionId).toBe(sessionId);
    expect(capturedData.reason).toBe("context_limit");
    expect(Array.isArray(capturedData.messages)).toBe(true);
    expect(capturedData.messages.length).toBeGreaterThan(0);
    // Every message in the array should have role and content
    for (const msg of capturedData.messages) {
      expect(msg.role).toBeDefined();
      expect(msg.content).toBeDefined();
    }
  });

  test("handler error does not prevent compaction", async () => {
    const { sessionId, activeSession } = await createSeededSession();

    hookRegistry.on("before_compaction", "broken-plugin", () => {
      throw new Error("plugin crashed");
    });

    const events: any[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    await callPerformSummarization(activeSession);

    unsub();

    // Compaction should have proceeded despite the error
    expect(generateTextCalled).toBe(true);
    expect(events.find((e) => e.type === "context_compacted")).toBeTruthy();
  });
});

// =============================================================================
// after_compaction hook tests
// =============================================================================

describe("after_compaction hook", () => {
  test("fires with correct data (sessionId, originalCount, compactedCount, summary)", async () => {
    const { sessionId, activeSession } = await createSeededSession();
    let capturedData: any = null;
    const hookCalled = new Promise<void>((resolve) => {
      hookRegistry.on("after_compaction", "test-plugin", (data) => {
        capturedData = data;
        resolve();
      });
    });

    await callPerformSummarization(activeSession);

    // after_compaction is fire-and-forget, wait for the handler to be called
    await hookCalled;

    expect(capturedData).not.toBeNull();
    expect(capturedData.sessionId).toBe(sessionId);
    expect(typeof capturedData.originalCount).toBe("number");
    expect(capturedData.originalCount).toBeGreaterThan(0);
    expect(capturedData.compactedCount).toBe(2);
    expect(capturedData.summary).toBe(GOOD_SUMMARY);
  });

  test("handler error does not affect caller", async () => {
    const { sessionId, activeSession } = await createSeededSession();

    hookRegistry.on("after_compaction", "broken-plugin", () => {
      throw new Error("after_compaction plugin crashed");
    });

    const events: any[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    // performSummarization should complete without throwing
    await callPerformSummarization(activeSession);

    unsub();

    // The compaction itself should have succeeded
    expect(events.find((e) => e.type === "context_compacted")).toBeTruthy();
    expect(activeSession.summarizing).toBe(false);
  });
});
