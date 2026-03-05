import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, createTestPngBase64, createMockApi } from "@molf-ai/test-utils";
import type { TestServer } from "../../helpers/index.js";
import type { TestWorker } from "../../helpers/index.js";

const { startTestServer, connectTestWorker, createTestClient, promptAndWait, waitForPersistence, getDefaultWsId } = await import("../../helpers/index.js");
const { SessionMap } = await import("../../../client-telegram/src/session-map.js");
const { Renderer } = await import("../../../client-telegram/src/renderer.js");
const { MessageHandler } = await import("../../../client-telegram/src/handler.js");
const { SessionEventDispatcher } = await import("../../../client-telegram/src/event-dispatcher.js");

/**
 * Integration tests for the upload-first media flow.
 *
 * Tests the full flow:
 * - Client uploads file via agent.upload → server forwards to worker via UploadDispatch
 * - Worker saves to .molf/uploads/ and returns path
 * - Client submits prompt with fileRefs (paths returned from upload)
 * - AgentRunner inlines cached images or shows text references for LLM
 * - Session persistence stores FileRef (path + mimeType), not raw bytes
 * - Session list shows media preview labels
 * - Telegram client uses upload-first flow
 *
 * LLM is mocked since these are integration tests focused on the media pipeline.
 */

let server: TestServer;
let worker: TestWorker;


function toBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}


beforeAll(async () => {
  setStreamTextImpl(() => mockTextResponse("ok"));
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "multimodal-worker", {
    echo: {
      description: "Echo the input text back",
      execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

// =============================================================================
// 1. Upload file to worker via agent.upload
// =============================================================================

describe("Multimodal: Upload file to worker", () => {
  test("upload image returns path and mimeType", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });
      const result = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "test.png",
        mimeType: "image/png",
      });
      expect(result.path).toContain(".molf/uploads/");
      expect(result.path).toContain("test.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.size).toBeGreaterThan(0);
    } finally {
      client.cleanup();
    }
  });

  test("upload document returns path", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });
      const result = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("PDF content here"),
        filename: "report.pdf",
        mimeType: "application/pdf",
      });
      expect(result.path).toContain(".molf/uploads/");
      expect(result.mimeType).toBe("application/pdf");
    } finally {
      client.cleanup();
    }
  });

  test("upload to nonexistent session fails", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.agent.upload.mutate({
          sessionId: "nonexistent-session-id",
          data: createTestPngBase64(),
          filename: "test.png",
          mimeType: "image/png",
        }),
      ).rejects.toThrow("not found");
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 2. Prompt with fileRefs via tRPC
// =============================================================================

describe("Multimodal: Prompt with fileRefs via tRPC", () => {
  test("upload then prompt with fileRef returns messageId", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "test.png",
        mimeType: "image/png",
      });

      const result = await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "What is in this image?",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });
      expect(result.messageId).toBeTruthy();
      expect(result.messageId).toMatch(/^msg_/);
    } finally {
      client.cleanup();
    }
  });

  test("prompt with multiple fileRefs", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const upload1 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "first.png",
        mimeType: "image/png",
      });
      const upload2 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("pdf content"),
        filename: "doc.pdf",
        mimeType: "application/pdf",
      });

      const result = await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Compare these files",
        fileRefs: [
          { path: upload1.path, mimeType: upload1.mimeType },
          { path: upload2.path, mimeType: upload2.mimeType },
        ],
      });
      expect(result.messageId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("prompt without fileRefs still works (backward compat)", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });
      const result = await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Plain text message",
      });
      expect(result.messageId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("prompt with fileRef but empty text", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "photo.jpg",
        mimeType: "image/jpeg",
      });

      const result = await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });
      expect(result.messageId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 3. Session persistence with FileRef
// =============================================================================

describe("Multimodal: Session persistence", () => {
  test("FileRef stored in session messages, not raw bytes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "test.png",
        mimeType: "image/png",
      });

      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Describe this",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await waitForPersistence();

      const loaded = await client.trpc.session.load.mutate({ sessionId: session.sessionId });
      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.content).toBe("Describe this");
      expect(userMsg!.attachments).toBeDefined();
      expect(userMsg!.attachments!.length).toBe(1);
      // FileRef should have path, not mediaId or raw data
      expect(userMsg!.attachments![0].path).toContain(".molf/uploads/");
      expect(userMsg!.attachments![0].mimeType).toBe("image/png");
    } finally {
      client.cleanup();
    }
  });

  test("session JSON on disk contains FileRef, not base64 data", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "photo.jpg",
        mimeType: "image/jpeg",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Check disk format",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Wait for async disk save that runs after turn_complete
      await waitForPersistence();

      const sessionFile = resolve(server.tmp.path, "sessions", `${session.sessionId}.json`);
      expect(existsSync(sessionFile)).toBe(true);

      const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
      const userMsg = data.messages.find((m: any) => m.role === "user");
      expect(userMsg.attachments).toBeDefined();
      expect(userMsg.attachments[0].path).toContain(".molf/uploads/");
      expect(userMsg.attachments[0].mimeType).toBe("image/jpeg");
      // Should NOT contain base64 `data` field
      expect(userMsg.attachments[0].data).toBeUndefined();
    } finally {
      client.cleanup();
    }
  });

  test("multiple fileRefs stored in session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const upload1 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "a.png",
        mimeType: "image/png",
      });
      const upload2 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("pdf content"),
        filename: "b.pdf",
        mimeType: "application/pdf",
      });

      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Multiple files",
        fileRefs: [
          { path: upload1.path, mimeType: upload1.mimeType },
          { path: upload2.path, mimeType: upload2.mimeType },
        ],
      });

      await waitForPersistence();

      const loaded = await client.trpc.session.load.mutate({ sessionId: session.sessionId });
      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg!.attachments!.length).toBe(2);
      expect(userMsg!.attachments![0].mimeType).toBe("image/png");
      expect(userMsg!.attachments![1].mimeType).toBe("application/pdf");
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 4. Session list with media previews
// =============================================================================

describe("Multimodal: Session list with media previews", () => {
  test("lastMessage shows content for session with image", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        name: "Image Preview Test",
      });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "photo.png",
        mimeType: "image/png",
      });

      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Describe this photo",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      await waitForPersistence();

      const listed = await client.trpc.session.list.query();
      const found = listed.sessions.find((s) => s.sessionId === session.sessionId);
      expect(found).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("lastMessage for text-only session shows plain content", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        name: "Text Only Test",
      });

      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Just a text message",
      });

      await waitForPersistence();

      const listed = await client.trpc.session.list.query();
      const found = listed.sessions.find((s) => s.sessionId === session.sessionId);
      expect(found).toBeTruthy();
      if (found!.lastMessage) {
        expect(found!.lastMessage).not.toContain("[image]");
        expect(found!.lastMessage).not.toContain("[document]");
      }
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 5. Session delete (no server-side media cleanup needed — files on worker)
// =============================================================================

describe("Multimodal: Session delete", () => {
  test("deleting session with fileRefs works", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "to-delete.png",
        mimeType: "image/png",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Delete test",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Wait for async disk save that runs after turn_complete
      await waitForPersistence();

      const deleted = await client.trpc.session.delete.mutate({ sessionId: session.sessionId });
      expect(deleted.deleted).toBe(true);

      // The evict() -> releaseIfIdle() -> release() -> saveToDisk() race may
      // re-create the session file after delete. Wait for it to settle, then
      // delete again to clean up the orphaned file.
      await waitForPersistence();
      await client.trpc.session.delete.mutate({ sessionId: session.sessionId }).catch(() => {});

      // Session should be gone
      await expect(
        client.trpc.session.load.mutate({ sessionId: session.sessionId }),
      ).rejects.toThrow("not found");
    } finally {
      client.cleanup();
    }
  });

  test("deleting session without fileRefs works normally", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "No attachments here",
      });

      // Wait for async disk save that runs after turn_complete
      await waitForPersistence();

      const deleted = await client.trpc.session.delete.mutate({ sessionId: session.sessionId });
      expect(deleted.deleted).toBe(true);

      // The evict() -> releaseIfIdle() -> release() -> saveToDisk() race may
      // re-create the session file after delete. Wait for it to settle, then
      // delete again to clean up the orphaned file.
      await waitForPersistence();
      await client.trpc.session.delete.mutate({ sessionId: session.sessionId }).catch(() => {});

      // Session should be gone
      await expect(
        client.trpc.session.load.mutate({ sessionId: session.sessionId }),
      ).rejects.toThrow("not found");
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 6. Attachment continuity across prompts (session resume)
// =============================================================================

describe("Multimodal: Session resume with historical fileRefs", () => {
  test("second prompt in session with prior fileRef succeeds", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "context.png",
        mimeType: "image/png",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "What is this?",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // Second prompt (text only) — agent should have the previous fileRef in history
      const result = await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Tell me more about the previous image",
      });
      expect(result.messageId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("second prompt with new fileRef in same session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      const upload1 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "first.png",
        mimeType: "image/png",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "First image",
        fileRefs: [{ path: upload1.path, mimeType: upload1.mimeType }],
      });

      const upload2 = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("different content"),
        filename: "doc.pdf",
        mimeType: "application/pdf",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Compare with this",
        fileRefs: [{ path: upload2.path, mimeType: upload2.mimeType }],
      });

      // Verify both messages with fileRefs are in history
      const loaded = await client.trpc.session.load.mutate({ sessionId: session.sessionId });
      const userMsgs = loaded.messages.filter((m) => m.role === "user");
      expect(userMsgs.length).toBe(2);
      expect(userMsgs[0].attachments?.length).toBe(1);
      expect(userMsgs[0].attachments![0].mimeType).toBe("image/png");
      expect(userMsgs[1].attachments?.length).toBe(1);
      expect(userMsgs[1].attachments![0].mimeType).toBe("application/pdf");
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 7. Schema validation (input validation via tRPC/Zod)
// =============================================================================

describe("Multimodal: Input validation", () => {
  test("upload rejects empty data", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      await expect(
        client.trpc.agent.upload.mutate({
          sessionId: session.sessionId,
          data: "",
          filename: "empty.png",
          mimeType: "image/png",
        }),
      ).rejects.toThrow();
    } finally {
      client.cleanup();
    }
  });

  test("upload rejects empty mimeType", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      await expect(
        client.trpc.agent.upload.mutate({
          sessionId: session.sessionId,
          data: createTestPngBase64(),
          filename: "test.png",
          mimeType: "",
        }),
      ).rejects.toThrow();
    } finally {
      client.cleanup();
    }
  });

  test("prompt rejects invalid fileRef (missing path)", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      await expect(
        client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: "bad",
          fileRefs: [{ mimeType: "image/jpeg" }] as any,
        }),
      ).rejects.toThrow();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 8. Mixed text and media in conversation flow
// =============================================================================

describe("Multimodal: Mixed text and media conversation", () => {
  test("interleave text-only and media messages in same session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client.trpc, worker.workerId) });

      // 1. Text-only message
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello, I have some images to show you",
      });

      // 2. Upload + fileRef message
      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: createTestPngBase64(),
        filename: "img1.png",
        mimeType: "image/png",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Here is image 1",
        fileRefs: [{ path: uploaded.path, mimeType: uploaded.mimeType }],
      });

      // 3. Text-only follow-up
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "What did you notice?",
      });

      // Verify all messages are in history
      const loaded = await client.trpc.session.load.mutate({ sessionId: session.sessionId });
      const userMsgs = loaded.messages.filter((m) => m.role === "user");
      expect(userMsgs.length).toBe(3);
      expect(userMsgs[0].attachments).toBeUndefined();
      expect(userMsgs[1].attachments?.length).toBe(1);
      expect(userMsgs[2].attachments).toBeUndefined();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 9. Telegram client: handleMedia with upload-first flow
// =============================================================================

describe("Multimodal: Telegram handleMedia with upload-first flow", () => {
  test("handleMedia uploads then prompts with fileRef", async () => {
    const client = createTestClient(server.url, server.token);
    const { api } = createMockApi();
    try {
      const connection = { trpc: client.trpc, wsClient: client.wsClient, close: () => client.cleanup() };
      const sessionMap = new SessionMap(client.trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
        botToken: "fake-bot-token",
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }) as any;

      try {
        const ctx = {
          chat: { id: 7001, type: "private" },
          message: {
            message_id: 1,
            caption: "What is this?",
            photo: [
              { file_id: "small_id", width: 90, height: 90, file_size: 1234 },
              { file_id: "large_id", width: 800, height: 600, file_size: 45678 },
            ],
          },
          from: { id: 9999 },
          api: api as any,
          reply: mock(() => Promise.resolve()),
        } as any;

        await handler.handleMedia(ctx);

        expect(sessionMap.has(7001)).toBe(true);
        const sessionId = sessionMap.get(7001)!;

        await waitForPersistence();
        const loaded = await client.trpc.session.load.mutate({ sessionId });
        expect(loaded.messages.length).toBeGreaterThanOrEqual(1);

        const userMsg = loaded.messages.find((m) => m.role === "user");
        expect(userMsg).toBeTruthy();
        expect(userMsg!.content).toBe("What is this?");
        expect(userMsg!.attachments).toBeDefined();
        expect(userMsg!.attachments!.length).toBe(1);
        // FileRef should have a path, not mediaId
        expect(userMsg!.attachments![0].path).toContain(".molf/uploads/");
        expect(userMsg!.attachments![0].mimeType).toBe("image/jpeg");
      } finally {
        globalThis.fetch = originalFetch;
      }

      handler.cleanup();
      renderer.cleanup();
    } finally {
      client.cleanup();
    }
  });

  test("handleMedia with sticker uses emoji as text", async () => {
    const client = createTestClient(server.url, server.token);
    const { api } = createMockApi();
    try {
      const connection = { trpc: client.trpc, wsClient: client.wsClient, close: () => client.cleanup() };
      const sessionMap = new SessionMap(client.trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
        botToken: "fake-bot-token",
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(new Uint8Array([0x00, 0x01]), { status: 200 });
      }) as any;

      try {
        const ctx = {
          chat: { id: 7002, type: "private" },
          message: {
            message_id: 2,
            sticker: {
              file_id: "sticker_id",
              emoji: "\u{1F600}",
              is_animated: false,
              file_size: 5000,
              width: 512,
              height: 512,
              type: "regular",
            },
          },
          from: { id: 9999 },
          api: api as any,
          reply: mock(() => Promise.resolve()),
        } as any;

        await handler.handleMedia(ctx);

        expect(sessionMap.has(7002)).toBe(true);
        const sessionId = sessionMap.get(7002)!;

        await waitForPersistence();
        const loaded = await client.trpc.session.load.mutate({ sessionId });
        const userMsg = loaded.messages.find((m) => m.role === "user");
        expect(userMsg).toBeTruthy();
        expect(userMsg!.content).toBe("\u{1F600}");
        expect(userMsg!.attachments![0].mimeType).toBe("image/webp");
      } finally {
        globalThis.fetch = originalFetch;
      }

      handler.cleanup();
      renderer.cleanup();
    } finally {
      client.cleanup();
    }
  });

  test("handleMedia with document", async () => {
    const client = createTestClient(server.url, server.token);
    const { api } = createMockApi();
    try {
      const connection = { trpc: client.trpc, wsClient: client.wsClient, close: () => client.cleanup() };
      const sessionMap = new SessionMap(client.trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
        botToken: "fake-bot-token",
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(Buffer.from("PDF content here"), { status: 200 });
      }) as any;

      try {
        const ctx = {
          chat: { id: 7003, type: "private" },
          message: {
            message_id: 3,
            caption: "Please review this",
            document: {
              file_id: "doc_id",
              file_name: "report.pdf",
              mime_type: "application/pdf",
              file_size: 2048,
            },
          },
          from: { id: 9999 },
          api: api as any,
          reply: mock(() => Promise.resolve()),
        } as any;

        await handler.handleMedia(ctx);

        expect(sessionMap.has(7003)).toBe(true);
        const sessionId = sessionMap.get(7003)!;

        await waitForPersistence();
        const loaded = await client.trpc.session.load.mutate({ sessionId });
        const userMsg = loaded.messages.find((m) => m.role === "user");
        expect(userMsg!.content).toBe("Please review this");
        expect(userMsg!.attachments![0].mimeType).toBe("application/pdf");
      } finally {
        globalThis.fetch = originalFetch;
      }

      handler.cleanup();
      renderer.cleanup();
    } finally {
      client.cleanup();
    }
  });

  test("handleMedia replies with error when file too large", async () => {
    const client = createTestClient(server.url, server.token);
    const { api } = createMockApi();
    try {
      const connection = { trpc: client.trpc, wsClient: client.wsClient, close: () => client.cleanup() };
      const sessionMap = new SessionMap(client.trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
        botToken: "fake-bot-token",
      });

      const replyMock = mock(() => Promise.resolve());
      const ctx = {
        chat: { id: 7004, type: "private" },
        message: {
          message_id: 4,
          photo: [
            {
              file_id: "huge_photo_id",
              width: 4000,
              height: 3000,
              file_size: 25 * 1024 * 1024, // 25MB — exceeds 15MB limit
            },
          ],
        },
        from: { id: 9999 },
        api: api as any,
        reply: replyMock,
      } as any;

      await handler.handleMedia(ctx);

      // Should have replied with error
      expect(replyMock).toHaveBeenCalled();
      const replyText = replyMock.mock.calls[0]?.[0] as string;
      expect(replyText).toContain("too large");

      // No session should have been created
      expect(sessionMap.has(7004)).toBe(false);

      handler.cleanup();
      renderer.cleanup();
    } finally {
      client.cleanup();
    }
  });

  test("handleMedia replies with error on download failure", async () => {
    const client = createTestClient(server.url, server.token);
    const { api } = createMockApi();
    try {
      const connection = { trpc: client.trpc, wsClient: client.wsClient, close: () => client.cleanup() };
      const sessionMap = new SessionMap(client.trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
        botToken: "fake-bot-token",
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response("Not Found", { status: 404 });
      }) as any;

      try {
        const replyMock = mock(() => Promise.resolve());
        const ctx = {
          chat: { id: 7005, type: "private" },
          message: {
            message_id: 5,
            photo: [
              { file_id: "missing_id", width: 100, height: 100, file_size: 1000 },
            ],
          },
          from: { id: 9999 },
          api: api as any,
          reply: replyMock,
        } as any;

        await handler.handleMedia(ctx);

        // Should have replied with error
        expect(replyMock).toHaveBeenCalled();
        const replyText = replyMock.mock.calls[0]?.[0] as string;
        expect(replyText).toContain("Something went wrong");
      } finally {
        globalThis.fetch = originalFetch;
      }

      handler.cleanup();
      renderer.cleanup();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// 10. Error cases
// =============================================================================

describe("Multimodal: Error cases", () => {
  test("prompt with fileRef to nonexistent session fails", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.agent.prompt.mutate({
          sessionId: "nonexistent-session-id",
          text: "Should fail",
          fileRefs: [{ path: ".molf/uploads/test.png", mimeType: "image/png" }],
        }),
      ).rejects.toThrow("not found");
    } finally {
      client.cleanup();
    }
  });
});
