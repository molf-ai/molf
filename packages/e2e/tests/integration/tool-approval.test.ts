import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { agentEventSchema } from "@molf-ai/protocol";
import type { AppRouter } from "@molf-ai/server";

let server: TestServer;
let worker: TestWorker;

function createClient(url: string, token: string) {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("token", token);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", "test-client");
  const wsClient = createWSClient({ url: wsUrl.toString() });
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
  return { trpc, wsClient };
}

beforeAll(async () => {
  server = startTestServer();
  worker = await connectTestWorker(server.url, server.token, "approval-worker");
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Tool Approval Workflow", () => {
  test("tool.approve returns applied=true", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.tool.approve.mutate({
        sessionId: "any",
        toolCallId: "any",
      });
      expect(result.applied).toBe(true);
    } finally {
      wsClient.close();
    }
  });

  test("tool.deny returns applied=false", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.tool.deny.mutate({
        sessionId: "any",
        toolCallId: "any",
      });
      expect(result.applied).toBe(false);
    } finally {
      wsClient.close();
    }
  });

  test("tool_approval_required event schema validates", () => {
    const event = {
      type: "tool_approval_required" as const,
      toolCallId: "tc-approval-1",
      toolName: "dangerous-tool",
      arguments: '{"action":"delete"}',
      sessionId: "sess-1",
    };

    const result = agentEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});
