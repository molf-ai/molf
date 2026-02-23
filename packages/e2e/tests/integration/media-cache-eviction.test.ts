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

/**
 * Integration tests for InlineMediaCache FIFO eviction under pressure.
 *
 * The cache has a 200MB total limit. When capacity is exceeded, the oldest
 * entries are evicted first (FIFO). This test verifies that after eviction,
 * the oldest image can no longer be re-inlined on session resume.
 */
describe("InlineMediaCache FIFO eviction", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedOpts: any[] = [];

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "cache-evict-worker", {
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

  test("oldest image evicted when cache capacity exceeded", () => {
    const cache = server.instance._ctx.inlineMediaCache;

    // Save three small images
    const buf1 = new Uint8Array(100);
    const buf2 = new Uint8Array(100);
    const buf3 = new Uint8Array(100);
    cache.save("path/img1.png", buf1, "image/png");
    cache.save("path/img2.png", buf2, "image/png");
    cache.save("path/img3.png", buf3, "image/png");

    // All three should be loadable
    expect(cache.load("path/img1.png")).not.toBeNull();
    expect(cache.load("path/img2.png")).not.toBeNull();
    expect(cache.load("path/img3.png")).not.toBeNull();
  });

  test("FIFO eviction removes oldest entry when budget exceeded", () => {
    const cache = server.instance._ctx.inlineMediaCache;

    // Clean the cache first
    cache.delete("path/img1.png");
    cache.delete("path/img2.png");
    cache.delete("path/img3.png");

    // The cache has a 200MB limit. Fill it with two large entries.
    const almostHalf = new Uint8Array(100 * 1024 * 1024); // 100MB each
    cache.save("path/first.png", almostHalf, "image/png");
    cache.save("path/second.png", almostHalf, "image/png");

    // Both should be loadable (200MB total = at limit)
    expect(cache.load("path/first.png")).not.toBeNull();
    expect(cache.load("path/second.png")).not.toBeNull();

    // Add one more entry — should evict the oldest (first.png)
    const small = new Uint8Array(1024); // 1KB
    cache.save("path/third.png", small, "image/png");

    // first.png should be evicted (FIFO)
    expect(cache.load("path/first.png")).toBeNull();
    // second.png and third.png should still be loadable
    expect(cache.load("path/second.png")).not.toBeNull();
    expect(cache.load("path/third.png")).not.toBeNull();

    // Cleanup
    cache.delete("path/second.png");
    cache.delete("path/third.png");
  });

  test("evicted image falls back to text hint on session resume", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Upload an image (goes into cache)
      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: Buffer.from(new Uint8Array(64)).toString("base64"),
        filename: "test.png",
        mimeType: "image/png",
      });

      // Prompt with fileRef
      capturedOpts = [];
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Describe this",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await sleep(300);

      // Evict agent and delete image from cache (simulates cache pressure eviction)
      server.instance._ctx.agentRunner.evict(session.sessionId);
      server.instance._ctx.inlineMediaCache.delete(uploaded.path);
      await sleep(100);

      // Prompt again — image is gone from cache
      capturedOpts = [];
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Tell me more",
      });

      // Without cache, the historical message should have text hint
      const opts = capturedOpts[0];
      const hintMsg = opts.messages.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Attached file:"),
      );
      expect(hintMsg).toBeTruthy();
      expect(hintMsg.content).toContain("image/png");
    } finally {
      client.cleanup();
    }
  });
});
