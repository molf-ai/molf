import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  promptAndWait,
  getDefaultWsId,
  waitForPersistence,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Doom Loop Detection E2E
// =============================================================================

describe("Doom loop detection", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedOpts: any[] = [];

  beforeAll(async () => {
    // Mock: return the same tool call with identical args 3 times,
    // then respond with text on the 4th call (after doom loop warning).
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      capturedOpts.push(opts);
      if (callCount <= 3) {
        const toolCallId = `tc_${callCount}`;
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "read_file",
              input: { path: "/etc/hosts" },
            };
            let result: unknown = "file contents";
            const toolDef = opts.tools?.["read_file"];
            if (toolDef?.execute) {
              result = await toolDef.execute({ path: "/etc/hosts" }, { toolCallId });
            }
            yield {
              type: "tool-result",
              toolCallId,
              toolName: "read_file",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      // After doom loop warning is injected, return final text
      callCount = 0;
      return mockTextResponse("I'll try a different approach.");
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "doomloop-worker", {
      read_file: {
        description: "Read a file",
        execute: async () => ({ output: "file contents" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("doom loop warning injected after 3 identical tool calls", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      capturedOpts = [];
      const { events } = await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Read the hosts file",
      });

      // Should have 3 tool call rounds
      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      expect(toolStarts.length).toBe(3);

      // All tool calls should be to "read_file"
      for (const tc of toolStarts) {
        expect((tc as any).toolName).toBe("read_file");
      }

      // Should complete with final text (4th LLM call after doom loop warning)
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("I'll try a different approach.");

      // 4 streamText calls: 3 tool rounds + 1 final text after warning
      expect(capturedOpts.length).toBe(4);

      // The 4th call should see the doom loop warning in its messages
      const lastCallMessages = capturedOpts[3].messages;
      const warningMsg = lastCallMessages.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("repeating the same action"),
      );
      expect(warningMsg).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// MaxSteps Limit E2E
// =============================================================================

describe("MaxSteps limit", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock: always return tool calls (never text), to exercise the maxSteps limit
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
            input: { text: `call-${callCount}` },
          };
          let result: unknown = "ok";
          const toolDef = opts.tools?.["echo"];
          if (toolDef?.execute) {
            result = await toolDef.execute({ text: `call-${callCount}` }, { toolCallId });
          }
          yield {
            type: "tool-result",
            toolCallId,
            toolName: "echo",
            output: result,
          };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "maxsteps-worker", {
      echo: {
        description: "Echo the input text",
        execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("exactly maxSteps (default 10) tool rounds execute then turn completes with fallback", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events } = await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Loop forever",
      });

      // Default maxSteps is 10 — should have exactly 10 tool call starts
      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      expect(toolStarts.length).toBe(10);

      // Turn should complete — the last assistant message has tool calls but no text,
      // so content is empty (P2-F2: lastAssistantMessage is always set, even without text)
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.role).toBe("assistant");

      // Verify session has the assistant message persisted
      await waitForPersistence();
      const loaded = await client.client.session.load({
        sessionId: session.sessionId,
      });

      const assistantMsgs = loaded.messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

      // Should have 10 tool result messages
      const toolMsgs = loaded.messages.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBe(10);
    } finally {
      client.cleanup();
    }
  });
});
