import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Session-Level Config Overrides: custom systemPrompt and LLM config
// =============================================================================

describe("Session-Level Config Overrides", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedSystemPrompt: string | undefined;
  let capturedMaxTokens: number | undefined;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      // Capture the system prompt and maxOutputTokens passed to the LLM
      capturedSystemPrompt = opts.system;
      capturedMaxTokens = opts.maxOutputTokens;
      return mockTextResponse("Config test response");
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "config-worker", {
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

  test("system prompt is built and passed to LLM", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Reset captured values
      capturedSystemPrompt = undefined;

      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      // The system prompt should contain the default Molf prompt
      expect(capturedSystemPrompt).toBeDefined();
      expect(capturedSystemPrompt).toContain("Molf");
    } finally {
      client.cleanup();
    }
  });

  test("custom maxTokens is passed to LLM", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Reset captured values
      capturedMaxTokens = undefined;

      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        config: {
          llm: {
            maxTokens: 100,
          },
        },
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      // maxTokens should be passed as maxOutputTokens
      expect(capturedMaxTokens).toBe(100);
    } finally {
      client.cleanup();
    }
  });

  test("session without config overrides uses defaults", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Reset captured values
      capturedSystemPrompt = undefined;
      capturedMaxTokens = undefined;

      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      // System prompt should be the default (no "pirate")
      expect(capturedSystemPrompt).toBeDefined();
      expect(capturedSystemPrompt).not.toContain("pirate");
    } finally {
      client.cleanup();
    }
  });

  test("maxSteps override limits tool call rounds", async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      const toolCallId = `tc_${callCount}`;
      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId,
            toolName: "echo",
            input: { text: `call ${callCount}` },
          };
          const toolDef = opts.tools?.["echo"];
          let result: unknown = "fallback";
          if (toolDef?.execute) {
            result = await toolDef.execute({ text: `call ${callCount}` }, { toolCallId });
          }
          yield {
            type: "tool-result",
            toolCallId,
            toolName: "echo",
            output: result,
          };
          // Always return tool-calls to keep looping
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    const client = createTestClient(server.url, server.token);
    try {
      callCount = 0;

      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        config: {
          behavior: {
            maxSteps: 2,
          },
        },
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Keep calling tools",
      });

      // With maxSteps=2, agent should stop after exactly 2 tool calls
      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      expect(toolStarts.length).toBe(2);

      // Should complete with turn_complete (not hang)
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});
