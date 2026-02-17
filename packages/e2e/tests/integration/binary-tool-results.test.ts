import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

/** A small valid 1x1 PNG as base64 */
const TINY_PNG_BASE64 = Buffer.from(new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])).toString("base64");

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
              result = await toolDef.execute({});
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

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "binary-worker", {
      take_screenshot: {
        description: "Take a screenshot",
        execute: async () => ({
          type: "binary",
          data: TINY_PNG_BASE64,
          mimeType: "image/png",
          path: ".molf/uploads/screenshot.png",
          size: 67,
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
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
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
      // The event result should contain the binary result info
      expect(tcEnd.result).toContain("image/png");
      expect(tcEnd.result).toContain("screenshot.png");

      // Turn completes with final text
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("I can see the screenshot.");
    } finally {
      client.cleanup();
    }
  });

  test("binary data is stripped from persisted session messages", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Screenshot please",
      });

      await sleep(300);

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Find the tool result message
      const toolMsg = loaded.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeTruthy();
      expect(toolMsg!.toolName).toBe("take_screenshot");

      // Content should have binary metadata but NOT the base64 data
      const content = JSON.parse(toolMsg!.content);
      expect(content.type).toBe("binary");
      expect(content.mimeType).toBe("image/png");
      expect(content.path).toContain("screenshot.png");
      expect(content.size).toBe(67);
      // base64 data should be stripped for persistence
      expect(content.data).toBeUndefined();
    } finally {
      client.cleanup();
    }
  });

  test("binary result base64 data is present in tool_call_end event", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Another screenshot",
      });

      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();

      // The event result is JSON-stringified and should contain the full
      // BinaryResult including base64 data (events are not stripped)
      const parsed = JSON.parse(tcEnd.result);
      expect(parsed.type).toBe("binary");
      expect(parsed.data).toBe(TINY_PNG_BASE64);
      expect(parsed.mimeType).toBe("image/png");
      expect(parsed.size).toBe(67);
    } finally {
      client.cleanup();
    }
  });
});
