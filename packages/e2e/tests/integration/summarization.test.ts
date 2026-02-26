import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mockTextResponse } from "@molf-ai/test-utils";
import { setStreamTextImpl, setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import type { AgentEvent } from "@molf-ai/protocol";

// --- Dynamic imports (AFTER harness sets up mocks) ---

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker, TestClient } from "../../helpers/index.js";

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
      // Return high usage to exceed 80% of a small (1000) context window
      setStreamTextImpl(() =>
        mockTextResponse("high usage response", {
          inputTokens: 850,
          outputTokens: 50,
          totalTokens: 900,
        }),
      );

      const client = createTestClient(server.url, server.token);
      try {
        // Create session with small context window
        const session = await client.trpc.session.create.mutate({
          workerId: worker.workerId,
          config: { llm: { contextWindow: 1000 } },
        });

        // Subscribe to events ONCE for the entire test — keep it open
        const { events: allEvents, unsubscribe } = collectEvents(
          client.trpc,
          session.sessionId,
        );
        await sleep(100); // let subscription establish

        // Seed enough messages (>= 6) by sending multiple prompts
        for (let i = 0; i < 3; i++) {
          await client.trpc.agent.prompt.mutate({
            sessionId: session.sessionId,
            text: `seed message ${i}`,
          });
          // Wait for turn_complete between prompts
          const start = Date.now();
          while (Date.now() - start < 5000) {
            const turnCompletes = allEvents.filter(
              (e) => e.type === "turn_complete",
            );
            if (turnCompletes.length >= i + 1) break;
            await sleep(20);
          }
          await sleep(50); // let status settle
        }

        // Now the 4th prompt — should trigger summarization
        await client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: "final prompt that triggers summarization",
        });

        // Wait for context_compacted (comes after turn_complete)
        const start = Date.now();
        while (Date.now() - start < 10_000) {
          if (allEvents.some((e) => e.type === "context_compacted")) break;
          await sleep(50);
        }
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
    // Return low usage (well below 80% of 200k default)
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
      });

      // Send several prompts
      for (let i = 0; i < 4; i++) {
        const { events: ev, unsubscribe: unsub } = collectEvents(
          client.trpc,
          session.sessionId,
        );
        await sleep(50);
        await client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: `low usage prompt ${i}`,
        });
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (ev.some((e) => e.type === "turn_complete")) break;
          await sleep(20);
        }
        // Check no context_compacted after each prompt
        await sleep(200);
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
      });

      const { events, unsubscribe } = collectEvents(
        client.trpc,
        session.sessionId,
      );
      await sleep(50);
      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "persist usage test",
      });
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (events.some((e) => e.type === "turn_complete")) break;
        await sleep(20);
      }
      unsubscribe();

      // Wait for persistence
      await sleep(200);

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
