import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  collectEvents,
  getDefaultWsId,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Agent Error Recovery: LLM throws on first prompt, second prompt succeeds
// =============================================================================

describe("Agent Error Recovery", () => {
  let server: TestServer;
  let worker: TestWorker;
  let shouldThrow = true;

  beforeAll(async () => {
    setStreamTextImpl(() => {
      if (shouldThrow) {
        // Throw inside the async generator so the error propagates through
        // the for-await-of loop in Agent.executeStep → caught by Agent.prompt's
        // outer catch → sets status to "error" and emits error event.
        return {
          fullStream: (async function* () {
            throw new Error("Simulated LLM API failure");
          })(),
        };
      }
      return mockTextResponse("Recovery successful!");
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "error-recovery-worker", {
      echo: {
        description: "Echo tool",
        execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "ok" }) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("agent recovers from LLM error and processes subsequent prompt", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // First prompt: mock throws, agent enters "error" state
      shouldThrow = true;
      const { events: errorEvents } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "This should fail",
      });

      // Verify error event was emitted
      const errorEvent = errorEvents.find((e) => e.type === "error");
      expect(errorEvent).toBeTruthy();
      expect((errorEvent as any).message).toContain("Simulated LLM API failure");

      // Verify agent entered "error" status
      const errorStatusChange = errorEvents.find(
        (e) => e.type === "status_change" && (e as any).status === "error",
      );
      expect(errorStatusChange).toBeTruthy();

      // Wait for status to settle
      await sleep(200);

      // Second prompt: mock succeeds — agent recovers from "error" state
      shouldThrow = false;
      const { events: successEvents } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "This should succeed",
      });

      // Verify successful turn_complete
      const turnComplete = successEvents.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
      expect((turnComplete as any).message.content).toBe("Recovery successful!");

      // Verify status transitioned through streaming → idle
      const statusChanges = successEvents
        .filter((e) => e.type === "status_change")
        .map((e) => (e as any).status);
      expect(statusChanges).toContain("streaming");
      expect(statusChanges[statusChanges.length - 1]).toBe("idle");
    } finally {
      client.cleanup();
    }
  });

  test("agent status returns to idle after successful recovery", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // First: trigger error
      shouldThrow = true;
      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Trigger error",
      });

      await sleep(100);

      // Verify status is "error" after failure
      const statusAfterError = await client.trpc.agent.status.query({
        sessionId: session.sessionId,
      });
      expect(statusAfterError.status).toBe("error");

      // Second: recover
      shouldThrow = false;
      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Recover",
      });

      await sleep(100);

      // Verify status is "idle" after recovery
      const statusAfterRecovery = await client.trpc.agent.status.query({
        sessionId: session.sessionId,
      });
      expect(statusAfterRecovery.status).toBe("idle");
    } finally {
      client.cleanup();
    }
  });
});
