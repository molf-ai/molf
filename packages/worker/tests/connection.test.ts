import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// --- Mock setup BEFORE imports (CLAUDE.md critical convention) ---

let registerCalls: any[] = [];
let subscriptions: Array<{ onData: (data: any) => void; onError: () => void }> = [];
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
      fsReadResult: { mutate: async () => ({ received: true }) },
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
  mockWsClient = null;
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
