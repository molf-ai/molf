import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  getDefaultWsId,
  sleep,
  waitUntil,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Gap 2: Turn timeout — abort during hung tool execution
//
// TURN_TIMEOUT_MS (10 min) is hardcoded and too long for tests. The timeout
// mechanism calls agentRunner.abort(), so we exercise that exact codepath:
// submit a prompt that triggers a never-resolving tool, then call abort().
// =============================================================================

describe("Turn timeout: abort during hung tool call", () => {
  let server: TestServer;
  let worker: TestWorker;
  // Allow the never-resolving tool promise to be cleaned up after test
  let rejectHang: (() => void) | null = null;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      const toolCallId = "tc_hung_1";
      return {
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId, toolName: "hang", input: {} };
          const toolDef = opts.tools?.["hang"];
          if (toolDef?.execute) {
            try {
              await toolDef.execute({}, { toolCallId });
            } catch {
              // tool execution aborted / cancelled
            }
          }
          yield { type: "tool-result", toolCallId, toolName: "hang", output: null };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "hang-worker", {
      hang: {
        description: "A tool that never completes",
        execute: async () =>
          new Promise((_, reject) => {
            rejectHang = () => reject(new Error("cancelled"));
          }),
      },
    } as any);
  });

  afterAll(() => {
    rejectHang?.(); // release the dangling promise
    worker.cleanup();
    server.cleanup();
  });

  test("abort terminates a hung tool call and emits aborted status", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      const promptPromise = client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "Use the hang tool",
      });

      // Wait for tool_call_start (agent is executing the hung tool)
      await waitUntil(
        () => events.some((e) => e.type === "tool_call_start"),
        5000,
        "tool_call_start event",
      );

      // Simulate what TURN_TIMEOUT_MS does: abort the agent
      const aborted = server.instance._ctx.agentRunner.abort(session.sessionId);
      expect(aborted).toBe(true);

      // Wait for aborted status
      await waitUntil(
        () =>
          events.some(
            (e) =>
              e.type === "status_change" &&
              ((e as any).status === "aborted" || (e as any).status === "idle"),
          ),
        5000,
        "aborted or idle status",
      );

      const statuses = events
        .filter((e) => e.type === "status_change")
        .map((e) => (e as any).status);
      expect(statuses).toContain("streaming");
      expect(
        statuses.includes("aborted") || statuses.includes("idle"),
      ).toBe(true);

      unsubscribe();
      await promptPromise.catch(() => {});
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Gap 3: Tool dispatch timeout (DEFAULT_TIMEOUT_MS = 120s)
//
// Tests WorkerDispatch timeout with a shortened timeout via direct inner
// access. ToolDispatch wrapper doesn't expose timeoutMs, so we reach the
// inner WorkerDispatch directly.
// =============================================================================

describe("Tool dispatch timeout", () => {
  let server: TestServer;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = await startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("dispatch to non-subscribing worker times out with error", async () => {
    const toolDispatch = server.instance._ctx.toolDispatch;
    const inner = (toolDispatch as any).inner;

    const promise = inner.dispatch(
      "ghost-worker",
      { toolCallId: "tc_timeout_1", toolName: "test", args: {} },
      500,
    );

    await expect(promise).rejects.toThrow(/timeout/i);
  });

  test("timeout error includes request id and duration", async () => {
    const toolDispatch = server.instance._ctx.toolDispatch;
    const inner = (toolDispatch as any).inner;

    const promise = inner.dispatch(
      "ghost-worker-2",
      { toolCallId: "tc_timeout_2", toolName: "test", args: {} },
      300,
    );

    try {
      await promise;
      throw new Error("Should not resolve");
    } catch (err: any) {
      expect(err.message).toContain("tc_timeout_2");
      expect(err.message).toContain("300ms");
    }
  });

  test("tool dispatch error propagates as error event to client", async () => {
    // Connect a real worker, then disconnect it mid-tool-execution.
    // The dispatch resolves with { error: "Worker disconnected" }, which
    // agent-runner's tool execute throws, propagating to the client as an
    // error event.
    setStreamTextImpl((opts: any) => {
      const toolCallId = "tc_dc_err_1";
      return {
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId, toolName: "delayed", input: {} };
          // Let the error propagate — agent-runner will throw on dispatch error
          const toolDef = opts.tools?.["delayed"];
          if (toolDef?.execute) {
            await toolDef.execute({}, { toolCallId });
          }
          yield { type: "tool-result", toolCallId, toolName: "delayed", output: null };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    const tempWorker = await connectTestWorker(server.url, server.token, "temp-dc-worker", {
      delayed: {
        description: "Delayed tool",
        execute: async () => {
          await sleep(500);
          return { output: "done" };
        },
      },
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: tempWorker.workerId,
        workspaceId: await getDefaultWsId(client.client, tempWorker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      const promptPromise = client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "Use the delayed tool",
      });

      // Wait for tool call to start
      await waitUntil(
        () => events.some((e) => e.type === "tool_call_start"),
        5000,
        "tool_call_start",
      );

      // Disconnect worker mid-execution — server auto-calls workerDisconnected
      tempWorker.cleanup();

      // Wait for error event from the dispatch failure propagation
      await waitUntil(
        () => events.some((e) => e.type === "error"),
        5000,
        "error event after worker disconnect",
      );

      const errorEvent = events.find((e) => e.type === "error") as any;
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.message).toBeTruthy();

      unsubscribe();
      await promptPromise.catch(() => {});
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Gap 4: Upload timeout (UPLOAD_TIMEOUT_MS = 30s in router)
//
// The router wraps uploadDispatch.dispatch() in Promise.race with a 30s timer.
// We test both: (a) inner dispatch timeout mechanism (fast), and
// (b) the real 30s timeout through oRPC that produces a TIMEOUT ORPCError.
// =============================================================================

describe("Upload timeout", () => {
  let server: TestServer;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("ok"));
    server = await startTestServer({ uploadTimeoutMs: 500 });
  });

  afterAll(() => {
    server.cleanup();
  });

  test("upload dispatch with short timeout rejects", async () => {
    const uploadDispatch = server.instance._ctx.uploadDispatch;
    const inner = (uploadDispatch as any).inner;

    const promise = inner.dispatch(
      "ghost-upload-worker",
      {
        uploadId: "upload_timeout_1",
        filename: "test.txt",
        mimeType: "text/plain",
        size: 4,
      },
      500,
    );

    await expect(promise).rejects.toThrow(/timeout/i);
  });

  test(
    "upload to unresponsive worker returns TIMEOUT ORPCError via oRPC",
    async () => {
      // Register a fake worker (proper UUID) — no real connection, so no one
      // subscribes to uploads. The dispatch queues and the 30s timer fires.
      const fakeWorkerId = crypto.randomUUID();
      server.instance._ctx.connectionRegistry.registerWorker({
        id: fakeWorkerId,
        name: "fake-upload-worker",
        connectedAt: Date.now(),
        tools: [],
        skills: [],
      });

      const client = createTestClient(server.url, server.token);
      try {
        const session = await client.client.session.create({
          workerId: fakeWorkerId,
          workspaceId: await getDefaultWsId(client.client, fakeWorkerId),
        });

        // Upload should timeout after ~500ms with ORPCError TIMEOUT
        await expect(
          client.client.fs.upload({
            sessionId: session.sessionId,
            file: new File([Buffer.from("test content")], "test.txt", { type: "text/plain" }),
          }),
        ).rejects.toThrow(/timeout/i);
      } finally {
        server.instance._ctx.uploadDispatch.workerDisconnected(fakeWorkerId);
        server.instance._ctx.connectionRegistry.unregister(fakeWorkerId);
        client.cleanup();
      }
    },
    5_000,
  );
});
