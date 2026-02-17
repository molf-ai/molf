import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndWait,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

/** Create a small valid PNG (1x1 red pixel) as base64 */
function createTestPngBase64(): string {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return Buffer.from(pngBytes).toString("base64");
}

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
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "reinline-worker", {
      echo: {
        description: "Echo tool",
        execute: async (args: any) => ({ echoed: args.text ?? "default" }),
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
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Upload image (cached in InlineMediaCache)
      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "test.png",
        mimeType: "image/png",
      });

      // First prompt with fileRef
      capturedOpts = [];
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Describe this image",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Wait for session save to complete
      await sleep(300);

      // Evict agent from cache (simulates idle eviction)
      server.instance._ctx.agentRunner.evict(session.sessionId);
      await sleep(100);

      // Second prompt triggers cold start + re-inlining
      capturedOpts = [];
      await promptAndWait(client.trpc, {
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
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Upload PDF (not cached in InlineMediaCache)
      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: Buffer.from("PDF content").toString("base64"),
        filename: "report.pdf",
        mimeType: "application/pdf",
      });

      capturedOpts = [];
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Review this document",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await sleep(300);
      server.instance._ctx.agentRunner.evict(session.sessionId);
      await sleep(100);

      capturedOpts = [];
      await promptAndWait(client.trpc, {
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
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "ephemeral.png",
        mimeType: "image/png",
      });

      capturedOpts = [];
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Look at this",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await sleep(300);

      // Evict agent AND delete image from media cache
      server.instance._ctx.agentRunner.evict(session.sessionId);
      server.instance._ctx.inlineMediaCache.delete(uploaded.path);
      await sleep(100);

      capturedOpts = [];
      await promptAndWait(client.trpc, {
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
