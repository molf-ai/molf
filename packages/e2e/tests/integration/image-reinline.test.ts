import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, createTestPngFile } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
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
 * Integration tests for image re-inlining on session resume.
 *
 * Verifies that when an agent is evicted from cache and a new prompt triggers
 * a cold start, historical image attachments are re-inlined from the
 * InlineMediaCache into the model messages.
 */
describe("Image re-inlining on session resume", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedOpts: any[] = [];

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "reinline-worker", {
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

  test("image is re-inlined from cache after agent eviction", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      // Upload image (cached in InlineMediaCache)
      const uploaded = await client.client.fs.upload({
        sessionId: session.sessionId,
        file: createTestPngFile("test.png"),
      });

      // First prompt with fileRef
      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "Describe this image",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Wait for session save to complete
      await waitForPersistence();

      // Evict agent from cache (simulates idle eviction)
      server.instance._ctx.agentRunner.evict(session.sessionId);

      // Second prompt triggers cold start + re-inlining
      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "What else can you tell me?",
      });

      // The streamText mock should receive historical messages with re-inlined image
      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const opts = capturedOpts[0];

      // Find the historical user message with image content (array of parts)
      const userMsgWithImage = opts.messages.find(
        (m: any) => m.role === "user" && Array.isArray(m.content),
      );
      expect(userMsgWithImage).toBeTruthy();

      // Should contain an image part with the re-inlined data
      const imagePart = userMsgWithImage.content.find(
        (p: any) => p.type === "image",
      );
      expect(imagePart).toBeTruthy();
      expect(imagePart.mediaType).toBe("image/png");
      expect(imagePart.image).toBeInstanceOf(Uint8Array);
    } finally {
      client.cleanup();
    }
  });

  test("non-image fileRef becomes text hint after eviction (no cache for non-images)", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      // Upload PDF (not cached in InlineMediaCache)
      const uploaded = await client.client.fs.upload({
        sessionId: session.sessionId,
        file: new File([Buffer.from("PDF content")], "report.pdf", { type: "application/pdf" }),
      });

      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "Review this document",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await waitForPersistence();
      server.instance._ctx.agentRunner.evict(session.sessionId);

      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "More details please",
      });

      // Historical user message should have text hint prepended (not binary)
      const opts = capturedOpts[0];
      const historicalUserMsg = opts.messages.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Attached file:"),
      );
      expect(historicalUserMsg).toBeTruthy();
      expect(historicalUserMsg.content).toContain("application/pdf");
      expect(historicalUserMsg.content).toContain("read_file");
    } finally {
      client.cleanup();
    }
  });

  test("image evicted from InlineMediaCache falls back to text hint", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const uploaded = await client.client.fs.upload({
        sessionId: session.sessionId,
        file: createTestPngFile("ephemeral.png"),
      });

      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "Look at this",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await waitForPersistence();

      // Evict agent AND delete image from media cache
      server.instance._ctx.agentRunner.evict(session.sessionId);
      server.instance._ctx.inlineMediaCache.delete(uploaded.path);
      await waitForPersistence();

      capturedOpts = [];
      await promptAndWait(client.client, {
        sessionId: session.sessionId,
        text: "Describe again",
      });

      // Without cache, the image should fall back to a text hint
      const opts = capturedOpts[0];
      const hintMsg = opts.messages.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Attached file:"),
      );
      expect(hintMsg).toBeTruthy();
      expect(hintMsg.content).toContain("image/png");
      expect(hintMsg.content).toContain("read_file");
    } finally {
      client.cleanup();
    }
  });
});
