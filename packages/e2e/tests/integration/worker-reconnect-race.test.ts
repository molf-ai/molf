import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, connectTestWorker, clearWsIdCache } from "../../helpers/index.js";
import { flushAsync } from "@molf-ai/test-utils";
import type { TestServer } from "../../helpers/index.js";

// =============================================================================
// Worker Reconnect Race Conditions: rapid reconnect edge cases
// =============================================================================

describe("Worker Reconnect Race Conditions", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => {
    clearWsIdCache();
    server.cleanup();
  });

  test("rapid reconnect cleans up stale connection", async () => {
    // Connect a worker normally
    const worker = await connectTestWorker(server.url, server.token, "race-worker-1", {
      ping: {
        description: "Ping tool",
        execute: async () => ({ output: "pong" }),
      },
    });
    const workerId = worker.workerId;

    const registry = server.instance._ctx.connectionRegistry;
    expect(registry.isConnected(workerId)).toBe(true);

    const workerBefore = registry.getWorker(workerId);
    expect(workerBefore).toBeTruthy();
    expect(workerBefore!.name).toBe("race-worker-1");

    // Simulate rapid reconnect: unregister old connection, then re-register
    // same workerId with fresh state before the old WS close fires.
    registry.unregister(workerId);
    expect(registry.isConnected(workerId)).toBe(false);

    registry.registerWorker({
      id: workerId,
      name: "race-worker-1-reconnected",
      connectedAt: Date.now(),
      tools: [
        {
          name: "ping_v2",
          description: "Ping v2 tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      skills: [],
      agents: [],
    });

    // After re-registration, only one entry should exist with fresh state
    expect(registry.isConnected(workerId)).toBe(true);
    const workerAfter = registry.getWorker(workerId);
    expect(workerAfter).toBeTruthy();
    expect(workerAfter!.name).toBe("race-worker-1-reconnected");
    expect(workerAfter!.tools).toHaveLength(1);
    expect(workerAfter!.tools[0].name).toBe("ping_v2");

    // Verify only one worker with this ID in the workers list
    const allWorkers = registry.getWorkers();
    const matching = allWorkers.filter((w) => w.id === workerId);
    expect(matching).toHaveLength(1);

    // Cleanup
    registry.unregister(workerId);
    worker.cleanup();
  });

  test("pending dispatches rejected on rapid reconnect", async () => {
    let toolStarted!: () => void;
    const toolStartedPromise = new Promise<void>((r) => (toolStarted = r));

    // Connect a worker with a tool that signals when it starts, then blocks
    const worker = await connectTestWorker(server.url, server.token, "race-worker-2", {
      slow_tool: {
        description: "A tool that blocks forever",
        execute: () => { toolStarted(); return new Promise(() => {}); },
      },
    });
    const workerId = worker.workerId;

    const toolDispatch = server.instance._ctx.toolDispatch;

    // Dispatch a tool call that will pend (the worker's tool blocks forever)
    const dispatchPromise = toolDispatch.dispatch(workerId, {
      toolCallId: "tc-race-1",
      toolName: "slow_tool",
      args: {},
    });

    // Wait for tool to actually start executing on the worker
    await toolStartedPromise;

    // Simulate rapid reconnect cleanup: call workerDisconnected to reject pending
    toolDispatch.workerDisconnected(workerId);

    // The dispatch promise should resolve with an error result (not reject/throw)
    const result = await dispatchPromise;
    expect(result.error).toBeDefined();
    expect(result.error).toContain("disconnected");
    expect(result.output).toBe("");

    worker.cleanup();
  });

  test("queued requests served to reconnected worker", async () => {
    const toolDispatch = server.instance._ctx.toolDispatch;
    const workerId = "queued-worker-" + Date.now();

    // Dispatch to a workerId that has no subscriber yet -- it gets queued
    const dispatchPromise = toolDispatch.dispatch(workerId, {
      toolCallId: "tc-queue-1",
      toolName: "echo",
      args: { text: "hello" },
    });

    // Dispatch queues synchronously when no subscriber exists
    await flushAsync();

    // Now connect a worker that will pick up the queued request.
    // We use the inner WorkerDispatch's subscribeWorker via the toolDispatch.
    // The simplest way: connect a real test worker with that workerId.
    // But connectTestWorker generates its own ID. Instead, we manually subscribe
    // and resolve.
    const ac = new AbortController();
    const received: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];

    // Subscribe as the worker -- this should drain the queue
    const subscriberDone = (async () => {
      for await (const request of toolDispatch.subscribeWorker(workerId, ac.signal)) {
        received.push(request);
        // Resolve the tool call
        toolDispatch.resolveToolCall(request.toolCallId, {
          output: `echo: ${(request.args as any).text}`,
        });
        // We only expect one request, break after
        break;
      }
    })();

    const result = await dispatchPromise;
    expect(result.output).toBe("echo: hello");
    expect(result.error).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0].toolCallId).toBe("tc-queue-1");

    ac.abort();
    await subscriberDone;
  });
});
