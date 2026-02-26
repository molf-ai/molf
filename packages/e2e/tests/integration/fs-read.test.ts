import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
  sleep,
} from "../../helpers/index.js";

// =============================================================================
// Integration test: fs.read over real WebSocket
//
// Tests the client -> server -> worker dispatch flow for reading files
// from the worker's .molf/tool-output/ directory.
// =============================================================================

describe("fs.read: happy path", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "fs-read-worker");

    // Pre-write a file the worker can read via fs.read
    worker.tmp.writeFile(".molf/tool-output/test-output.txt", "hello from tool output\n");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("reads file by outputId", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const result = await client.trpc.fs.read.mutate({
        sessionId: session.sessionId,
        outputId: "test-output",
      });

      expect(result.content).toBe("hello from tool output\n");
      expect(result.size).toBeGreaterThan(0);
      expect(result.encoding).toBe("utf-8");
    } finally {
      client.cleanup();
    }
  });

  test("reads file by path", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const result = await client.trpc.fs.read.mutate({
        sessionId: session.sessionId,
        path: ".molf/tool-output/test-output.txt",
      });

      expect(result.content).toBe("hello from tool output\n");
      expect(result.size).toBeGreaterThan(0);
    } finally {
      client.cleanup();
    }
  });
});

describe("fs.read: error cases", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("throws NOT_FOUND for non-existent session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.fs.read.mutate({
          sessionId: "non-existent-session",
          outputId: "out1",
        }),
      ).rejects.toThrow(/not found/i);
    } finally {
      client.cleanup();
    }
  });

  test("throws PRECONDITION_FAILED when worker is disconnected", async () => {
    const tempWorker = await connectTestWorker(
      server.url,
      server.token,
      "temp-fs-worker",
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: tempWorker.workerId,
      });

      // Disconnect the worker
      tempWorker.cleanup();
      await sleep(200);

      await expect(
        client.trpc.fs.read.mutate({
          sessionId: session.sessionId,
          outputId: "some-output",
        }),
      ).rejects.toThrow(/not connected|PRECONDITION_FAILED|disconnected/i);
    } finally {
      client.cleanup();
    }
  });

  test("throws error for non-existent file", async () => {
    const fsWorker = await connectTestWorker(
      server.url,
      server.token,
      "fs-worker-nofile",
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: fsWorker.workerId,
      });

      await expect(
        client.trpc.fs.read.mutate({
          sessionId: session.sessionId,
          outputId: "does-not-exist",
        }),
      ).rejects.toThrow(/INTERNAL_SERVER_ERROR|no such file|ENOENT/i);
    } finally {
      client.cleanup();
      fsWorker.cleanup();
    }
  });

  test("throws error for path traversal outside allowed directory", async () => {
    const fsWorker = await connectTestWorker(
      server.url,
      server.token,
      "fs-worker-traversal",
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: fsWorker.workerId,
      });

      await expect(
        client.trpc.fs.read.mutate({
          sessionId: session.sessionId,
          path: "../../../etc/passwd",
        }),
      ).rejects.toThrow(/access denied|INTERNAL_SERVER_ERROR|outside/i);
    } finally {
      client.cleanup();
      fsWorker.cleanup();
    }
  });
});
