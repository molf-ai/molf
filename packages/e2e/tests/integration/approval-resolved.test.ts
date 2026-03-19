import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  waitUntil,
  getDefaultWsId,
  clearWsIdCache,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// tool_approval_resolved event: clients receive resolution events
// =============================================================================

describe("Tool approval resolved events", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_resolved_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "shell_exec",
              input: { command: "echo hi" },
            };
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["shell_exec"];
            if (toolDef?.execute) {
              result = await toolDef.execute(
                { command: "echo hi" },
                { toolCallId },
              );
            }
            yield {
              type: "tool-result",
              toolCallId,
              toolName: "shell_exec",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      callCount = 0;
      return mockTextResponse("Done.");
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "resolved-event-worker", {
      shell_exec: {
        description: "Execute a shell command",
        execute: async () => ({ output: "exit code: 0" }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("approve emits tool_approval_resolved with outcome 'approved'", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const events: AgentEvent[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);

      try {
        const iter = await client.client.agent.onEvents({ sessionId: session.sessionId });
        client.client.agent.prompt({ sessionId: session.sessionId, text: "Run echo hi" }).catch(() => {});

        for await (const event of iter) {
          if (abort.signal.aborted) throw new Error("Timed out");
          events.push(event);

          if (event.type === "tool_approval_required") {
            const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
            client.client.tool.approve({
              sessionId: session.sessionId,
              approvalId: ev.approvalId,
            }).catch(() => {});
          }

          if (event.type === "turn_complete") break;
        }
      } finally {
        clearTimeout(timer);
        abort.abort();
      }

      // Verify tool_approval_resolved was emitted
      const resolved = events.find((e) => e.type === "tool_approval_resolved") as any;
      expect(resolved).toBeDefined();
      expect(resolved.outcome).toBe("approved");
      expect(resolved.approvalId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("deny emits tool_approval_resolved with outcome 'denied'", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const events: AgentEvent[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);

      try {
        const iter = await client.client.agent.onEvents({ sessionId: session.sessionId });
        client.client.agent.prompt({ sessionId: session.sessionId, text: "Run something" }).catch(() => {});

        for await (const event of iter) {
          if (abort.signal.aborted) throw new Error("Timed out");
          events.push(event);

          if (event.type === "tool_approval_required") {
            const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
            client.client.tool.deny({
              sessionId: session.sessionId,
              approvalId: ev.approvalId,
              feedback: "Not allowed",
            }).catch(() => {});
          }

          if (event.type === "error" || event.type === "turn_complete") break;
        }
      } finally {
        clearTimeout(timer);
        abort.abort();
      }

      const resolved = events.find((e) => e.type === "tool_approval_resolved") as any;
      expect(resolved).toBeDefined();
      expect(resolved.outcome).toBe("denied");
    } finally {
      client.cleanup();
    }
  });

  test("second client receives tool_approval_resolved when first client approves", async () => {
    const client1 = createTestClient(server.url, server.token);
    const client2 = createTestClient(server.url, server.token);
    try {
      const session = await client1.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client1.client, worker.workerId),
      });

      // Client 2 subscribes to the same session
      const { events: events2, started: started2, unsubscribe: unsub2 } =
        collectEvents(client2.client, session.sessionId);
      await started2;

      const events1: AgentEvent[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);

      try {
        const iter = await client1.client.agent.onEvents({ sessionId: session.sessionId });
        client1.client.agent.prompt({ sessionId: session.sessionId, text: "Run command" }).catch(() => {});

        for await (const event of iter) {
          if (abort.signal.aborted) throw new Error("Timed out");
          events1.push(event);

          if (event.type === "tool_approval_required") {
            const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
            // Client 1 approves
            client1.client.tool.approve({
              sessionId: session.sessionId,
              approvalId: ev.approvalId,
            }).catch(() => {});
          }

          if (event.type === "turn_complete") break;
        }
      } finally {
        clearTimeout(timer);
        abort.abort();
      }

      // Wait for client 2 to receive the resolved event
      await waitUntil(
        () => events2.some((e) => e.type === "tool_approval_resolved"),
        5000,
        "client 2 to receive tool_approval_resolved",
      );

      const resolved2 = events2.find((e) => e.type === "tool_approval_resolved") as any;
      expect(resolved2).toBeDefined();
      expect(resolved2.outcome).toBe("approved");

      unsub2();
    } finally {
      client1.cleanup();
      client2.cleanup();
    }
  });
});
