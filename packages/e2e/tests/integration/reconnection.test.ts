import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";

let server: TestServer;

beforeAll(() => {
  server = startTestServer();
});

afterAll(() => {
  server.cleanup();
});

describe("Reconnection Scenarios", () => {
  test("worker disconnect during active tool call resolves with error", async () => {
    const worker = await connectTestWorker(server.url, server.token, "dc-worker", {
      slowTool: {
        description: "A slow tool",
        execute: async () => {
          // This tool takes a long time - worker will disconnect before it completes
          await Bun.sleep(5000);
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

    // Disconnect worker while tool is executing
    await Bun.sleep(50);
    worker.cleanup();
    await Bun.sleep(100);

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
    await Bun.sleep(100);

    expect(registry.isConnected(worker.workerId)).toBe(false);
  });

  test("server restart preserves sessions on disk", async () => {
    const tmp = createTmpDir("molf-restart-");

    // Start server 1, create a session
    const server1 = startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      llm: { provider: "gemini", model: "test" },
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
    const server2 = startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      llm: { provider: "gemini", model: "test" },
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
    await Bun.sleep(100);

    const worker2 = await connectTestWorker(server.url, server.token, "new-worker");
    expect(registry.isConnected(worker2.workerId)).toBe(true);

    worker2.cleanup();
  });
});
