import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import type { AgentEvent } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  waitUntil,
  getDefaultWsId,
  sleep,
  clearWsIdCache,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Tool call cancellation: abort signal propagates to worker tool executor
// =============================================================================

describe("Tool call cancellation", () => {
  let server: TestServer;
  let worker: TestWorker;
  let toolAbortReceived = false;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      const toolCallId = "tc_cancel_1";
      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId,
            toolName: "cancellable_tool",
            input: {},
          };
          const toolDef = opts.tools?.["cancellable_tool"];
          let result: unknown = "fallback";
          if (toolDef?.execute) {
            try {
              // Pass abortSignal from streamText opts so cancel propagates to tool-builder
              result = await toolDef.execute({}, { toolCallId, abortSignal: opts.abortSignal });
            } catch {
              return;
            }
          }
          yield {
            type: "tool-result",
            toolCallId,
            toolName: "cancellable_tool",
            output: result,
          };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "cancel-tool-worker", {
      cancellable_tool: {
        description: "A tool that watches for abort signal",
        execute: async (_args: any, ctx: any) => {
          // Wait for abort signal or timeout
          if (ctx.abortSignal?.aborted) {
            toolAbortReceived = true;
            return { output: "cancelled" };
          }
          return new Promise<{ output: string }>((resolve) => {
            const timer = setTimeout(() => {
              resolve({ output: "completed normally" });
            }, 5000);
            ctx.abortSignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              toolAbortReceived = true;
              resolve({ output: "cancelled" });
            }, { once: true });
          });
        },
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("abort during tool execution sends cancel signal to worker", async () => {
    toolAbortReceived = false;
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      // Send prompt (triggers tool call)
      client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "Use the cancellable tool",
      });

      // Wait for tool execution to start
      await waitUntil(
        () => events.some(
          (e) => e.type === "status_change" && (e as any).status === "executing_tool",
        ),
        5000,
        "executing_tool status",
      );

      // Small delay to ensure tool is running
      await sleep(100);

      // Abort — this should propagate cancel to the worker
      const abortResult = await client.client.agent.abort({ sessionId: session.sessionId });
      expect(abortResult.aborted).toBe(true);

      // Wait for aborted status
      await waitUntil(
        () => events.some(
          (e) => e.type === "status_change" && (e as any).status === "aborted",
        ),
        5000,
        "aborted status",
      );

      // Give the worker time to receive the cancel signal via onToolCancel subscription
      await waitUntil(
        () => toolAbortReceived,
        3000,
        "tool to receive abort signal",
      );

      unsubscribe();
    } finally {
      client.cleanup();
    }
  });
});
