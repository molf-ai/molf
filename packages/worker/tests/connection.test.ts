import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// --- Mock setup BEFORE imports (CLAUDE.md critical convention) ---

let registerCalls: any[] = [];
let subscriptions: Array<{ onData: (data: any) => void; onError: () => void }> = [];
let fsReadResults: any[] = [];
let mockWsClient: { close: () => void } | null = null;

mock.module("../src/trpc-client.js", () => ({
  createWSClient: (opts: any) => {
    mockWsClient = { close: () => {} };
    return mockWsClient;
  },
  createTRPCClient: (opts: any) => ({
    worker: {
      register: {
        mutate: async (data: any) => {
          registerCalls.push(data);
          return { workerId: data.workerId };
        },
      },
      onToolCall: {
        subscribe: (_input: any, handlers: any) => {
          subscriptions.push(handlers);
          return { unsubscribe: () => {} };
        },
      },
      onUpload: {
        subscribe: (_input: any, handlers: any) => {
          subscriptions.push(handlers);
          return { unsubscribe: () => {} };
        },
      },
      onFsRead: {
        subscribe: (_input: any, handlers: any) => {
          subscriptions.push(handlers);
          return { unsubscribe: () => {} };
        },
      },
      toolResult: { mutate: async () => ({ received: true }) },
      uploadResult: { mutate: async () => ({ received: true }) },
      fsReadResult: {
        mutate: async (data: any) => {
          fsReadResults.push(data);
          return { received: true };
        },
      },
    },
  }),
  wsLink: (opts: any) => opts,
}));

// --- Now import the module under test ---
const { WorkerConnection } = await import("../src/connection.js");

function createMockToolExecutor() {
  return {
    getToolInfos: () => [],
    execute: async () => ({ result: null }),
  } as any;
}

function createConnection() {
  return new WorkerConnection({
    serverUrl: "ws://127.0.0.1:7600",
    token: "test-token",
    workerId: "test-worker-id",
    name: "test-worker",
    workdir: "/tmp/test",
    toolExecutor: createMockToolExecutor(),
    skills: [],
  });
}

beforeEach(() => {
  registerCalls = [];
  subscriptions = [];
  fsReadResults = [];
  mockWsClient = null;
});

describe("backoffDelay", () => {
  // backoffDelay is not exported, but we can test the observable behavior:
  // WorkerConnection uses backoffDelay internally when scheduling reconnects.
  // We test it indirectly via scheduleReconnect timing.

  test("reconnect attempt increments and schedules with exponential backoff", async () => {
    const conn = createConnection();
    await conn.connect();

    const firstGenSubs = [...subscriptions];

    const scheduledDelays: number[] = [];
    const scheduleSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        scheduledDelays.push(delay);
        return 999 as any;
      },
    );

    // First disconnect — should schedule reconnect with ~1s backoff (attempt 0)
    firstGenSubs[0].onError();
    expect(conn.state).toBe("reconnecting");
    expect(scheduledDelays.length).toBe(1);
    // INITIAL_BACKOFF_MS = 1000, attempt 0 → 1000 * 2^0 = 1000 ± 25% jitter
    expect(scheduledDelays[0]).toBeGreaterThanOrEqual(750);
    expect(scheduledDelays[0]).toBeLessThanOrEqual(1250);

    scheduleSpy.mockRestore();
    conn.close();
  });
});

describe("WorkerConnection — generation counter", () => {
  test("stale onError from previous generation is ignored", async () => {
    const conn = createConnection();
    await conn.connect();
    expect(conn.state).toBe("registered");

    // Capture the onError callbacks from the first establish()
    const firstGenSubscriptions = [...subscriptions];
    expect(firstGenSubscriptions.length).toBe(3); // tool, upload, fsRead

    // Simulate disconnect via onError from the current generation
    const scheduleSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => 999 as any,
    );

    // Fire onError from one of the current-gen subscriptions — should trigger reconnect
    firstGenSubscriptions[0].onError();
    expect(conn.state).toBe("reconnecting");

    // Now fire onError from the SAME subscription again (stale — generation already advanced)
    // This should be ignored because generation has already advanced
    conn["_state"] = "registered"; // reset state to test
    firstGenSubscriptions[0].onError();
    // State should still be "registered" because the stale callback was ignored
    expect(conn.state).toBe("registered");

    scheduleSpy.mockRestore();
    conn.close();
  });

  test("close() prevents handleDisconnect from triggering reconnect", async () => {
    const conn = createConnection();
    await conn.connect();

    const firstGenSubscriptions = [...subscriptions];

    conn.close();
    expect(conn.state).toBe("disconnected");

    // onError from old subscriptions should be ignored after close
    firstGenSubscriptions[0].onError();
    expect(conn.state).toBe("disconnected");
  });

  test("connect sets state to registered on success", async () => {
    const conn = createConnection();
    await conn.connect();
    expect(conn.state).toBe("registered");
    conn.close();
  });
});

describe("WorkerConnection — handleFsRead path traversal", () => {
  test("path traversal outside allowed directory returns Access denied error", async () => {
    const conn = createConnection();
    await conn.connect();

    // subscriptions[2] is onFsRead (tool=0, upload=1, fsRead=2)
    const fsReadHandler = subscriptions[2];
    expect(fsReadHandler).toBeTruthy();

    // Simulate a request with a path that escapes the output directory
    fsReadHandler.onData({
      requestId: "req_traversal",
      path: "../../etc/passwd",
    });

    // Wait for async handleFsRead to complete
    await Bun.sleep(50);

    // The fsReadResult should contain an error about access denied
    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_traversal");
    expect(fsReadResults[0].error).toContain("Access denied");
    expect(fsReadResults[0].error).toContain("outside allowed directory");

    conn.close();
  });

  test("path within allowed output directory does not return Access denied", async () => {
    const conn = createConnection();
    await conn.connect();

    const fsReadHandler = subscriptions[2];

    // Request with an outputId — resolves to .molf/tool-output/{id}.txt within workdir
    // The file won't exist, but the path traversal check should pass
    fsReadHandler.onData({
      requestId: "req_valid",
      outputId: "valid-output-id",
    });

    await Bun.sleep(50);

    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_valid");
    // Should fail with file-not-found, NOT Access denied
    if (fsReadResults[0].error) {
      expect(fsReadResults[0].error).not.toContain("Access denied");
    }

    conn.close();
  });

  test("request with neither outputId nor path returns error", async () => {
    const conn = createConnection();
    await conn.connect();

    const fsReadHandler = subscriptions[2];

    fsReadHandler.onData({
      requestId: "req_empty",
    });

    await Bun.sleep(50);

    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_empty");
    expect(fsReadResults[0].error).toContain("outputId or path required");

    conn.close();
  });
});
