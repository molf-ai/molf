import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { createTestPngBase64, createTestPngFile } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  promptAndCollect,
  waitForPersistence,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

const TINY_PNG_BASE64 = createTestPngBase64();

/**
 * Integration tests for binary tool results flowing through the system.
 *
 * When a worker tool returns { type: "binary", data, mimeType, path, size },
 * the server:
 * 1. Dispatches and receives the binary result from the worker
 * 2. Emits tool_call_end with the full result
 * 3. Strips binary data before session persistence
 * 4. Registers a toModelOutput callback for image inlining (tested via SDK)
 */
describe("Binary tool results (image inlining)", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_binary_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "take_screenshot",
              input: {},
            };
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["take_screenshot"];
            if (toolDef?.execute) {
              result = await toolDef.execute({}, { toolCallId });
            }
            yield {
              type: "tool-result",
              toolCallId,
              toolName: "take_screenshot",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      callCount = 0;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "I can see the screenshot." };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "binary-worker", {
      take_screenshot: {
        description: "Take a screenshot",
        execute: async () => ({
          output: "[Binary file: screenshot.png, 67 bytes]",
          attachments: [{
            mimeType: "image/png",
            data: createTestPngFile("screenshot.png"),
            path: ".molf/uploads/screenshot.png",
            size: 67,
          }],
        }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("binary result flows through tool dispatch and completes turn", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events } = await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Take a screenshot",
      });

      // Tool call dispatched to worker
      const tcStart = events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart).toBeTruthy();
      expect(tcStart.toolName).toBe("take_screenshot");

      // Tool result received from worker
      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();
      expect(tcEnd.toolName).toBe("take_screenshot");
      // The event result should contain the output text referencing the binary
      expect(tcEnd.result).toContain("screenshot.png");

      // Turn completes with final text
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("I can see the screenshot.");
    } finally {
      client.cleanup();
    }
  });

  test("binary output is persisted as plain text (attachments are sideband)", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Screenshot please",
      });

      await waitForPersistence();

      const loaded = await client.client.session.load({
        sessionId: session.sessionId,
      });

      // Find the tool result message
      const toolMsg = loaded.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeTruthy();
      expect(toolMsg!.toolName).toBe("take_screenshot");

      // Content is the plain text output string (no base64 data in persisted messages)
      expect(toolMsg!.content).toContain("screenshot.png");
      // The base64 data should NOT be in the persisted content
      expect(toolMsg!.content).not.toContain(TINY_PNG_BASE64);
    } finally {
      client.cleanup();
    }
  });

  test("tool_call_end event contains the output text", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events } = await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Another screenshot",
      });

      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();

      // The event result contains the output text
      expect(tcEnd.result).toContain("screenshot.png");
    } finally {
      client.cleanup();
    }
  });
});
