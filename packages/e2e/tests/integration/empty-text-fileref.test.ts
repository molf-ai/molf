import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, createTestPngBase64 } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  promptAndWait,
  waitForPersistence,
  getDefaultWsId,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});


/**
 * Integration tests for prompting with empty text and fileRef only.
 *
 * Users may send images without any text. The agent should still receive
 * the image attachment and produce a response.
 */
describe("Prompt with empty text and fileRef only", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedOpts: any[] = [];

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("I can see the image.");
    });
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "empty-text-worker", {
      echo: {
        description: "Echo tool",
        execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("empty text with image fileRef produces response", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const uploaded = await client.client.file.upload({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "photo.png",
        mimeType: "image/png",
      });

      capturedOpts = [];
      const { events } = await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Should complete with response
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("I can see the image.");

      // The model should have received the image attachment
      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const opts = capturedOpts[0];
      // Use findLast to skip the runtime context message injected before the actual user message
      const userMsg = opts.messages.findLast(
        (m: any) => m.role === "user",
      );
      expect(userMsg).toBeTruthy();

      // User message should have image content (array with image part)
      expect(Array.isArray(userMsg.content)).toBe(true);
      const imagePart = userMsg.content.find((p: any) => p.type === "image");
      expect(imagePart).toBeTruthy();
      expect(imagePart.mediaType).toBe("image/png");
    } finally {
      client.cleanup();
    }
  });

  test("session persists empty-text message with fileRef attachment", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const uploaded = await client.client.file.upload({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "silent.png",
        mimeType: "image/png",
      });

      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await waitForPersistence();

      const loaded = await client.client.session.load({
        sessionId: session.sessionId,
      });

      // User message should have empty text and attachment
      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.content).toBe("");
      expect(userMsg!.attachments).toBeDefined();
      expect(userMsg!.attachments!.length).toBe(1);
      expect(userMsg!.attachments![0].mimeType).toBe("image/png");

      // Should have assistant response
      const assistantMsg = loaded.messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();
      expect(assistantMsg!.content).toBe("I can see the image.");
    } finally {
      client.cleanup();
    }
  });
});
