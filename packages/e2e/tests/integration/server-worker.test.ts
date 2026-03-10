import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
} from "../../helpers/index.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "e2e-worker", {
    echo: {
      description: "Echo the input text",
      execute: async (args: any) => ({ output: `echoed: ${args.text}` }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

// Session CRUD tests (create, list, load, rename, delete, tool.list, agent.list)
// are covered comprehensively in full-flow.test.ts.

describe("Server-Worker Integration: tool approval edge cases", () => {
  test("tool.approve with unknown approvalId returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.approve.mutate({
        sessionId: "any-session",
        approvalId: "any-tc",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool.deny returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.deny.mutate({
        sessionId: "any-session",
        approvalId: "any-tc",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });
});
