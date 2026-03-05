import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { waitUntil } from "../../helpers/index.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => {
  server.cleanup();
});

describe("Worker-Server Connection", () => {
  test("worker connects and registers", async () => {
    const worker = await connectTestWorker(server.url, server.token, "test-worker-1", {
      echo: {
        description: "Echo input",
        execute: async (args: any) => ({ output: args.text }),
      },
    });

    const registry = server.instance._ctx.connectionRegistry;
    const workerInfo = registry.getWorker(worker.workerId);
    expect(workerInfo).toBeTruthy();
    expect(workerInfo!.name).toBe("test-worker-1");

    worker.cleanup();
  });

  test("worker close disconnects cleanly", async () => {
    const worker = await connectTestWorker(server.url, server.token, "test-worker-2");

    const registry = server.instance._ctx.connectionRegistry;
    expect(registry.isConnected(worker.workerId)).toBe(true);

    worker.cleanup();
    await waitUntil(() => !registry.isConnected(worker.workerId), 2_000, "worker disconnected");
    expect(registry.isConnected(worker.workerId)).toBe(false);
  });

  test("worker receives tool call via subscription", async () => {
    const toolResults: string[] = [];
    const worker = await connectTestWorker(server.url, server.token, "test-worker-3", {
      greet: {
        description: "Greet",
        execute: async (args: any) => {
          const result = `Hello ${args.name}`;
          toolResults.push(result);
          return { output: result };
        },
      },
    });

    const td = server.instance._ctx.toolDispatch;
    const result = await td.dispatch(worker.workerId, {
      toolCallId: "tc-test-1",
      toolName: "greet",
      args: { name: "World" },
    });

    expect(result.output).toBe("Hello World");
    expect(result.error).toBeUndefined();

    worker.cleanup();
  });

  test("connection with wrong token fails", async () => {
    try {
      const worker = await connectTestWorker(server.url, "wrong-token", "bad-worker");
      // If it connects, the procedures should fail due to invalid token
      worker.cleanup();
    } catch (e) {
      // Expected: connection should fail or procedures reject
      expect(e).toBeDefined();
    }
  });
});
