import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  promptAndCollect,
  sleep,
  waitUntil,
} = await import("../../helpers/index.js");

import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// P1: Session list pagination
// =============================================================================

describe("Session list pagination", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "pagination-worker");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("limit and offset paginate results correctly", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create 5 sessions
      const sessionIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const s = await client.trpc.session.create.mutate({
          workerId: worker.workerId,
          name: `Page Test ${i}`,
        });
        sessionIds.push(s.sessionId);
      }

      // Query first page (limit=2, offset=0)
      const page1 = await client.trpc.session.list.query({ limit: 2, offset: 0 });
      expect(page1.sessions.length).toBe(2);
      expect(page1.total).toBeGreaterThanOrEqual(5);

      // Query second page
      const page2 = await client.trpc.session.list.query({ limit: 2, offset: 2 });
      expect(page2.sessions.length).toBe(2);

      // Pages should not overlap
      const page1Ids = new Set(page1.sessions.map((s) => s.sessionId));
      const page2Ids = new Set(page2.sessions.map((s) => s.sessionId));
      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false);
      }

      // Query with offset beyond total
      const pageBeyond = await client.trpc.session.list.query({
        limit: 2,
        offset: page1.total + 10,
      });
      expect(pageBeyond.sessions.length).toBe(0);
      expect(pageBeyond.total).toBe(page1.total);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P1: Worker rename via tRPC
// =============================================================================

describe("Worker rename via tRPC", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("rename worker and verify in agent.list", async () => {
    const worker = await connectTestWorker(
      server.url,
      server.token,
      "original-name",
    );
    const client = createTestClient(server.url, server.token);
    try {
      // Verify original name
      let list = await client.trpc.agent.list.query();
      let found = list.workers.find((w) => w.workerId === worker.workerId);
      expect(found).toBeTruthy();
      expect(found!.name).toBe("original-name");

      // Rename via tRPC
      const result = await client.trpc.worker.rename.mutate({
        workerId: worker.workerId,
        name: "renamed-worker",
      });
      expect(result.renamed).toBe(true);

      // Verify new name
      list = await client.trpc.agent.list.query();
      found = list.workers.find((w) => w.workerId === worker.workerId);
      expect(found!.name).toBe("renamed-worker");
    } finally {
      client.cleanup();
      worker.cleanup();
    }
  });

  test("rename non-existent worker returns NOT_FOUND", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.worker.rename.mutate({
          workerId: "00000000-0000-0000-0000-000000000000",
          name: "new-name",
        }),
      ).rejects.toThrow(/not found/i);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P1: Agent abort, busy, and status during streaming
// =============================================================================

describe("Agent abort and busy handling", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Slow mock: yields characters with delay so we can test abort/busy
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        for (const char of "ABCDEFGHIJ") {
          await sleep(200);
          yield { type: "text-delta" as const, text: char };
        }
        yield { type: "finish" as const, finishReason: "stop" };
      })(),
    }));

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "slow-worker", {
      echo: {
        description: "Echo",
        execute: async (args: any) => ({ output: args.text }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("agent.abort during streaming returns aborted status", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Subscribe to events
      const events: AgentEvent[] = [];
      const sub = client.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events.push(e) },
      );

      // Wait for subscription to connect, then submit prompt
      await sleep(150);
      const promptResult = client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "slow prompt",
      });

      // Wait for streaming to start
      await waitUntil(
        () => events.some((e) => e.type === "content_delta"),
        5000,
        "content_delta to appear",
      );

      // Abort
      const abortResult = await client.trpc.agent.abort.mutate({
        sessionId: session.sessionId,
      });
      expect(abortResult.aborted).toBe(true);

      // Wait for abort status event
      await waitUntil(
        () =>
          events.some(
            (e) => e.type === "status_change" && (e as any).status === "aborted",
          ),
        5000,
        "aborted status event",
      );

      const statuses = events
        .filter((e) => e.type === "status_change")
        .map((e) => (e as any).status);
      expect(statuses).toContain("streaming");
      expect(statuses).toContain("aborted");

      sub.unsubscribe();
      // Catch any prompt rejection from abort
      await promptResult.catch(() => {});
    } finally {
      client.cleanup();
    }
  });

  test("AgentBusyError when sending concurrent prompts to same session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Start a slow prompt
      const events: AgentEvent[] = [];
      const sub = client.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events.push(e) },
      );

      await sleep(150);
      const firstPromise = client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "first prompt (slow)",
      });

      // Wait for streaming to start
      await waitUntil(
        () => events.some((e) => e.type === "status_change" && (e as any).status === "streaming"),
        5000,
        "streaming to start",
      );

      // Second prompt should fail with CONFLICT
      await expect(
        client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: "second prompt (should fail)",
        }),
      ).rejects.toThrow(/already processing|CONFLICT/i);

      sub.unsubscribe();
      // Abort and clean up
      await client.trpc.agent.abort.mutate({ sessionId: session.sessionId });
      await firstPromise.catch(() => {});
    } finally {
      client.cleanup();
    }
  });

  test("agent.status returns 'streaming' during active streaming", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const events: AgentEvent[] = [];
      const sub = client.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events.push(e) },
      );

      await sleep(150);
      const promptPromise = client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "check status while streaming",
      });

      // Wait for streaming to start
      await waitUntil(
        () => events.some((e) => e.type === "content_delta"),
        5000,
        "content_delta to appear",
      );

      // Query status during streaming
      const status = await client.trpc.agent.status.query({
        sessionId: session.sessionId,
      });
      expect(status.status).toBe("streaming");

      sub.unsubscribe();
      // Abort and clean up
      await client.trpc.agent.abort.mutate({ sessionId: session.sessionId });
      await promptPromise.catch(() => {});
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P1: WorkerDisconnectedError via prompt
// =============================================================================

describe("WorkerDisconnectedError via prompt", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("prompt after worker disconnect throws PRECONDITION_FAILED", async () => {
    const worker = await connectTestWorker(
      server.url,
      server.token,
      "soon-disconnected",
    );
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Disconnect the worker
      worker.cleanup();
      await sleep(200);

      // Prompt should fail because worker is disconnected
      await expect(
        client.trpc.agent.prompt.mutate({
          sessionId: session.sessionId,
          text: "should fail",
        }),
      ).rejects.toThrow(/disconnected|PRECONDITION_FAILED/i);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P1: Auth rejection (unauthenticated call)
// =============================================================================

describe("Auth rejection", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("connection with invalid token gets UNAUTHORIZED on tRPC call", async () => {
    const client = createTestClient(server.url, "wrong-token-value");
    try {
      await expect(client.trpc.session.list.query()).rejects.toThrow(
        /UNAUTHORIZED|authentication/i,
      );
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P2: Multiple clients subscribe to same session events
// =============================================================================

describe("Multiple clients same session", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("Hello both!"));
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "multi-client-worker");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("two clients subscribing to same session both receive events", async () => {
    const client1 = createTestClient(server.url, server.token, "client-1");
    const client2 = createTestClient(server.url, server.token, "client-2");
    try {
      const session = await client1.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];

      const sub1 = client1.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events1.push(e) },
      );
      const sub2 = client2.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events2.push(e) },
      );

      // Wait for subscriptions to connect
      await sleep(200);

      // Submit prompt from client1
      await client1.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Both should see this",
      });

      // Wait for both clients to receive turn_complete
      await waitUntil(
        () => events1.some((e) => e.type === "turn_complete"),
        10000,
        "client1 turn_complete",
      );
      await waitUntil(
        () => events2.some((e) => e.type === "turn_complete"),
        10000,
        "client2 turn_complete",
      );

      // Both clients should have received the same event types
      expect(events1.map((e) => e.type)).toContain("content_delta");
      expect(events2.map((e) => e.type)).toContain("content_delta");
      expect(events1.map((e) => e.type)).toContain("turn_complete");
      expect(events2.map((e) => e.type)).toContain("turn_complete");

      sub1.unsubscribe();
      sub2.unsubscribe();
    } finally {
      client1.cleanup();
      client2.cleanup();
    }
  });
});

// =============================================================================
// P2: Worker duplicate registration
// =============================================================================

describe("Worker duplicate registration", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("registering same workerId twice replaces stale connection", async () => {
    const worker1 = await connectTestWorker(
      server.url,
      server.token,
      "dup-worker",
    );
    try {
      // Re-register same workerId via a new client (simulates reconnection)
      const client = createTestClient(server.url, server.token);
      try {
        const result = await client.trpc.worker.register.mutate({
          workerId: worker1.workerId,
          name: "dup-worker-2",
          tools: [],
        });
        expect(result.workerId).toBe(worker1.workerId);
      } finally {
        client.cleanup();
      }
    } finally {
      worker1.cleanup();
    }
  });
});

// =============================================================================
// P2: Tool executor error propagation
// =============================================================================

describe("Tool executor error propagation", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock that calls the tool (which will throw)
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_err_1",
              toolName: "failing_tool",
              input: {},
            };
            // Execute the tool which throws
            let output: unknown = "fallback";
            try {
              const toolDef = opts.tools?.["failing_tool"];
              if (toolDef?.execute) {
                output = await toolDef.execute({}, { toolCallId: "tc_err_1" });
              }
            } catch (err) {
              // Tool threw an error, yield it as error
              yield { type: "tool-error", error: err };
              yield { type: "finish", finishReason: "stop" };
              return;
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_err_1",
              toolName: "failing_tool",
              output,
            };
            yield { type: "finish", finishReason: "stop" };
          })(),
        };
      }
      callCount = 0;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "recovered" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "error-worker", {
      failing_tool: {
        description: "A tool that always throws",
        execute: async () => {
          throw new Error("Tool execution failed!");
        },
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("tool that throws propagates error event to client", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const events: AgentEvent[] = [];
      const sub = client.trpc.agent.onEvents.subscribe(
        { sessionId: session.sessionId },
        { onData: (e) => events.push(e) },
      );

      await sleep(150);
      await client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Trigger failing tool",
      });

      // Wait for error event or turn_complete
      await waitUntil(
        () =>
          events.some(
            (e) => e.type === "error" || e.type === "turn_complete",
          ),
        10000,
        "error or turn_complete event",
      );

      // Should have received an error event
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBeGreaterThan(0);

      sub.unsubscribe();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P3: Session rename not found
// =============================================================================

describe("Session rename not found", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("renaming non-existent session throws NOT_FOUND", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.session.rename.mutate({
          sessionId: "non-existent-session",
          name: "New Name",
        }),
      ).rejects.toThrow(/not found/i);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P3: Tool list session not found
// =============================================================================

describe("Tool list session not found", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("tool.list with nonexistent session throws NOT_FOUND", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.tool.list.query({ sessionId: "non-existent-session" }),
      ).rejects.toThrow(/not found/i);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P2: Tool list returns empty when worker disconnected
// =============================================================================

describe("Tool list with disconnected worker", () => {
  let server: TestServer;

  beforeAll(() => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("tool.list returns empty array when session worker is disconnected", async () => {
    const worker = await connectTestWorker(server.url, server.token, "temp-worker", {
      echo: { description: "Echo", execute: async (args: any) => ({ output: args.text }) },
    });
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Verify tools exist while connected
      const toolsBefore = await client.trpc.tool.list.query({
        sessionId: session.sessionId,
      });
      expect(toolsBefore.tools.length).toBe(1);

      // Disconnect worker
      worker.cleanup();
      await sleep(200);

      // tool.list should return empty array
      const toolsAfter = await client.trpc.tool.list.query({
        sessionId: session.sessionId,
      });
      expect(toolsAfter.tools.length).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});
