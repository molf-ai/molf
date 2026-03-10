import { vi, describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest"; 
import { mockTextResponse } from "@molf-ai/test-utils";
import { setStreamTextImpl, setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import type { AgentEvent } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  getDefaultWsId,
  waitUntil,
  waitForPersistence,
} from "../../helpers/index.js";

import type { TestServer, TestWorker, TestClient } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Summarization: full flow
// =============================================================================

describe("Summarization: full flow", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setGenerateTextImpl(() =>
      Promise.resolve({
        text: "## Goal\nTest summary\n\n## Key Instructions\nNone\n\n## Progress\nDone\n\n## Key Findings\nNone\n\n## Relevant Files\nNone",
      }),
    );

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "sum-e2e-worker", {
      echo: {
        description: "Echo input",
        execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test(
    "prompt with high usage → context_compacted event after turn_complete",
    async () => {
      // Return high usage to exceed 80% of the 128k context window (from test model)
      setStreamTextImpl(() =>
        mockTextResponse("high usage response", {
          inputTokens: 108_800,
          outputTokens: 1_000,
          totalTokens: 109_800,
        }),
      );

      const client = createTestClient(server.url, server.token);
      try {
        const session = await client.trpc.session.create.mutate({
          workerId: worker.workerId,
          workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        });

        // Subscribe to events ONCE for the entire test — keep it open
        const { events: allEvents, started, unsubscribe } = collectEvents(
          client.trpc,
          session.sessionId,
        );
        await started;

        // Seed enough messages so there are messages to summarize beyond KEEP_RECENT_TURNS (4).
        // We need at least 5 prompts: 4 kept + 1 to summarize.
        for (let i = 0; i < 5; i++) {
          await client.trpc.agent.prompt.mutate({
            sessionId: session.sessionId,
            text: `seed message ${i}`,
          });
          // Wait for turn_complete between prompts
          await waitUntil(
            () => allEvents.filter((e) => e.type === "turn_complete").length >= i + 1,
            10_000,
            `turn_complete #${i + 1}`,
          );
        }

        // Now the 4th prompt — should trigger summarization
        await client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: "final prompt that triggers summarization",
        });

        // Wait for context_compacted (comes after turn_complete)
        await waitUntil(
          () => allEvents.some((e) => e.type === "context_compacted"),
          10_000,
          "context_compacted event",
        );
        unsubscribe();

        const compacted = allEvents.find(
          (e) => e.type === "context_compacted",
        ) as any;
        expect(compacted).toBeTruthy();
        expect(compacted.summaryMessageId).toBeTruthy();
      } finally {
        client.cleanup();
      }
    },
    30_000,
  );

  test("no summarization when below threshold", async () => {
    // Return low usage (well below 80% of 128k test model context window)
    setStreamTextImpl(() =>
      mockTextResponse("low usage response", {
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
      }),
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Send several prompts
      for (let i = 0; i < 4; i++) {
        const { events: ev, started: evStarted, unsubscribe: unsub } = collectEvents(
          client.trpc,
          session.sessionId,
        );
        await evStarted;
        await client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: `low usage prompt ${i}`,
        });
        await waitUntil(
          () => ev.some((e) => e.type === "turn_complete"),
          5000,
          `turn_complete for prompt ${i}`,
        );
        // Check no context_compacted after each prompt
        await waitForPersistence();
        const compacted = ev.find((e) => e.type === "context_compacted");
        expect(compacted).toBeUndefined();
        unsub();
      }
    } finally {
      client.cleanup();
    }
  });

  test("token usage persists on assistant messages in session", async () => {
    setStreamTextImpl(() =>
      mockTextResponse("usage persist e2e", {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
      }),
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(
        client.trpc,
        session.sessionId,
      );
      await started;
      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "persist usage test",
      });
      await waitUntil(
        () => events.some((e) => e.type === "turn_complete"),
        5000,
        "turn_complete",
      );
      unsubscribe();

      // Wait for persistence
      await waitForPersistence();

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      const assistantMsgs = loaded.messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      expect(lastAssistant.usage).toBeTruthy();
      expect(lastAssistant.usage!.inputTokens).toBe(500);
      expect(lastAssistant.usage!.outputTokens).toBe(100);
    } finally {
      client.cleanup();
    }
  });
});
