import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, createTestProviderConfig, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, waitUntil, type TestWorker } from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => {
  server.cleanup();
});

describe("Reconnection Scenarios", () => {
  test("worker disconnect during active tool call resolves with error", async () => {
    let toolStarted!: () => void;
    const toolStartedPromise = new Promise<void>((r) => (toolStarted = r));

    const worker = await connectTestWorker(server.url, server.token, "dc-worker", {
      slowTool: {
        description: "A slow tool",
        execute: async () => {
          toolStarted();
          // This tool blocks until worker disconnects
          await new Promise(() => {});
          return { output: "done" };
        },
      },
    });

    const td = server.instance._ctx.toolDispatch;
    const dispatchPromise = td.dispatch(worker.workerId, {
      toolCallId: "tc-dc-1",
      toolName: "slowTool",
      args: {},
    });

    // Wait for tool to actually start executing on worker
    await toolStartedPromise;
    worker.cleanup();
    await waitUntil(() => !server.instance._ctx.connectionRegistry.isConnected(worker.workerId), 2_000, "worker disconnected");

    // Force worker disconnect notification
    td.workerDisconnected(worker.workerId);

    const result = await dispatchPromise;
    expect(result.error).toBeTruthy();
  });

  test("worker disconnect while idle cleans up registry", async () => {
    const worker = await connectTestWorker(server.url, server.token, "idle-dc-worker");
    const registry = server.instance._ctx.connectionRegistry;
    expect(registry.isConnected(worker.workerId)).toBe(true);

    worker.cleanup();
    await waitUntil(() => !registry.isConnected(worker.workerId), 2_000, "worker disconnected");

    expect(registry.isConnected(worker.workerId)).toBe(false);
  });

  test("server restart preserves sessions on disk", async () => {
    const tmp = createTmpDir("molf-restart-");

    const providerConfig = createTestProviderConfig(tmp.path);

    // Start server 1, create a session
    const server1 = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      model: "gemini/test",
      providerConfig,
    });
    const mgr1 = server1._ctx.sessionMgr;
    const session = await mgr1.create({ workerId: "fake-worker" });
    mgr1.addMessage(session.sessionId, {
      id: "msg-1",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    await mgr1.save(session.sessionId);
    server1.close();

    // Start server 2 with same dataDir
    const server2 = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      model: "gemini/test",
      providerConfig,
    });
    const mgr2 = server2._ctx.sessionMgr;
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe("hello");

    server2.close();
    tmp.cleanup();
  });

  test("new worker connects after old disconnects", async () => {
    const worker1 = await connectTestWorker(server.url, server.token, "old-worker");
    const registry = server.instance._ctx.connectionRegistry;
    expect(registry.isConnected(worker1.workerId)).toBe(true);

    worker1.cleanup();
    await waitUntil(() => !registry.isConnected(worker1.workerId), 2_000, "old worker disconnected");

    const worker2 = await connectTestWorker(server.url, server.token, "new-worker");
    expect(registry.isConnected(worker2.workerId)).toBe(true);

    worker2.cleanup();
  });

  test("disconnect during tool call returns specific error message", async () => {
    let toolStarted!: () => void;
    const toolStartedPromise = new Promise<void>((r) => (toolStarted = r));

    const worker = await connectTestWorker(server.url, server.token, "dc-msg-worker", {
      slowTool: {
        description: "A slow tool",
        execute: async () => {
          toolStarted();
          await new Promise(() => {});
          return { output: "done" };
        },
      },
    });

    const td = server.instance._ctx.toolDispatch;
    const dispatchPromise = td.dispatch(worker.workerId, {
      toolCallId: "tc-dc-msg-1",
      toolName: "slowTool",
      args: {},
    });

    // Wait for tool to actually start executing, then disconnect
    await toolStartedPromise;
    td.workerDisconnected(worker.workerId);

    const result = await dispatchPromise;
    expect(result.error).toBeTruthy();
    // The error message should specifically mention the worker disconnection
    expect(typeof result.error).toBe("string");
    expect(result.error!.toLowerCase()).toMatch(/disconnect/);

    worker.cleanup();
  });
});
