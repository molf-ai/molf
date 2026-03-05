import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndWait,
  waitForPersistence,
  getDefaultWsId,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Non-Image FileRef as Text Hint: verify text/plain files appear as text hints
// =============================================================================

function toBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

describe("Non-Image FileRef as Text Hint", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedSystem: string | undefined;
  let capturedMessages: any[] | undefined;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      capturedSystem = opts.system;
      capturedMessages = opts.messages;
      return mockTextResponse("Got the file reference");
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "fileref-worker", {
      read_file: {
        description: "Read a file from disk",
        execute: async (args: any) => ({ output: JSON.stringify({ content: "file contents" }) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("non-image fileRef produces text hint in prompt", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Upload a text file
      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("Hello, this is a text file."),
        filename: "notes.txt",
        mimeType: "text/plain",
      });

      // Reset captured messages
      capturedMessages = undefined;

      // Prompt with the text fileRef
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "What is in this file?",
        fileRefs: [{ path: uploaded.path, mimeType: "text/plain" }],
      });

      // Verify the LLM received a text hint instead of binary data
      // The messages sent to LLM should contain the hint
      expect(capturedMessages).toBeDefined();

      // Find the actual user message (skip runtime context injected before it)
      const userMsg = capturedMessages!.findLast((m: any) => m.role === "user");
      expect(userMsg).toBeTruthy();

      // The content should contain the [Attached file: ...] hint
      const contentStr = typeof userMsg.content === "string"
        ? userMsg.content
        : JSON.stringify(userMsg.content);
      expect(contentStr).toContain("[Attached file:");
      expect(contentStr).toContain(uploaded.path);
      expect(contentStr).toContain("text/plain");
    } finally {
      client.cleanup();
    }
  });

  test("non-image fileRef is persisted in session with path and mimeType", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const uploaded = await client.trpc.agent.upload.mutate({
        sessionId: session.sessionId,
        data: toBase64("PDF content goes here"),
        filename: "report.pdf",
        mimeType: "application/pdf",
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Summarize this document",
        fileRefs: [{ path: uploaded.path, mimeType: "application/pdf" }],
      });

      await waitForPersistence();

      // Load session and verify persistence
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.attachments).toBeDefined();
      expect(userMsg!.attachments!.length).toBe(1);
      expect(userMsg!.attachments![0].path).toBe(uploaded.path);
      expect(userMsg!.attachments![0].mimeType).toBe("application/pdf");
    } finally {
      client.cleanup();
    }
  });
});
