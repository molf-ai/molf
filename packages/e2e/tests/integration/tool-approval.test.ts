import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
} from "../../helpers/index.js";
import { agentEventSchema } from "@molf-ai/protocol";

let server: TestServer;
let worker: TestWorker;

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
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.approve.mutate({
        sessionId: "any",
        toolCallId: "any",
      });
      expect(result.applied).toBe(true);
    } finally {
      client.cleanup();
    }
  });

  test("tool.deny returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.deny.mutate({
        sessionId: "any",
        toolCallId: "any",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
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
