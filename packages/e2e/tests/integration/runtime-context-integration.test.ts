import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  waitForPersistence,
  getDefaultWsId,
  clearWsIdCache,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

/**
 * Integration tests for runtime context injection into LLM calls.
 *
 * Verifies that the server injects a runtime context user message (containing
 * current time and timezone) into the messages sent to the LLM, and that this
 * ephemeral message is NOT persisted to the session store.
 */
describe("Runtime context integration", () => {
  let server: TestServer;
  let worker: TestWorker;
  let capturedMessages: any[] | undefined;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockTextResponse("Runtime context test response");
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "runtime-context-worker", {
      echo: {
        description: "Echo tool",
        execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "ok" }) }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("current time/timezone injected into LLM system prompt", async () => {
    capturedMessages = undefined;

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      expect(capturedMessages).toBeTruthy();
      const contextMsg = capturedMessages!.find(
        (m: any) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Runtime Context]"),
      );
      expect(contextMsg).toBeTruthy();
      expect(contextMsg.content).toContain("Current time:");
      expect(contextMsg.content).toContain("Timezone:");
    } finally {
      client.cleanup();
    }
  });

  test("runtime context not persisted to session", async () => {
    capturedMessages = undefined;

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      await promptAndCollect(client.client, {
        sessionId: session.sessionId,
        text: "Hello again",
      });

      await waitForPersistence();

      const loaded = await client.client.session.load({
        sessionId: session.sessionId,
      });

      const contextMessages = loaded.messages.filter(
        (m: any) =>
          typeof m.content === "string" && m.content.includes("[Runtime Context]"),
      );
      expect(contextMessages.length).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});
