import { describe, it, expect, mock, beforeEach } from "bun:test";
import { resolveWorkerId, subscribeToEvents } from "../src/connection.js";

// --- connectToServer tests (requires mocking @trpc/client) ---

const createWSClientMock = mock(() => ({ close: () => {} }));
const createTRPCClientMock = mock(() => ({}));

mock.module("@trpc/client", () => ({
  createWSClient: createWSClientMock,
  createTRPCClient: createTRPCClientMock,
  wsLink: mock(() => "mock-link"),
}));

const { connectToServer } = await import("../src/connection.js");

describe("connectToServer", () => {
  beforeEach(() => {
    createWSClientMock.mockClear();
    createTRPCClientMock.mockClear();
  });

  it("includes clientId in WebSocket URL", () => {
    connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    expect(createWSClientMock).toHaveBeenCalledTimes(1);
    const call = createWSClientMock.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.has("clientId")).toBe(true);
    expect(url.searchParams.get("clientId")).toBeTruthy();
  });

  it("sets name in WebSocket URL and passes WebSocket class for auth", () => {
    connectToServer({ serverUrl: "ws://localhost:7600", token: "my-token" });

    const call = createWSClientMock.mock.calls[0][0] as { url: string; WebSocket?: unknown };
    const url = new URL(call.url);
    expect(url.searchParams.get("name")).toBe("telegram");
    // Token should NOT be in the URL (moved to Authorization header)
    expect(url.searchParams.has("token")).toBe(false);
    // WebSocket class should be provided for header injection
    expect(call.WebSocket).toBeTruthy();
  });

  it("configures WebSocket reconnection with retryDelayMs", () => {
    connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    const opts = createWSClientMock.mock.calls[0][0] as any;
    expect(typeof opts.retryDelayMs).toBe("function");
    expect(typeof opts.onOpen).toBe("function");
    expect(typeof opts.onClose).toBe("function");

    // Verify backoff produces reasonable delays
    const delay0 = opts.retryDelayMs(0);
    const delay5 = opts.retryDelayMs(5);
    expect(delay0).toBeGreaterThan(0);
    expect(delay0).toBeLessThanOrEqual(1500); // 1000 + 25% jitter
    expect(delay5).toBeLessThanOrEqual(37500); // 30000 + 25% jitter
  });
});

describe("resolveWorkerId", () => {
  it("returns preferred worker ID when provided", async () => {
    const mockTrpc = {} as any; // Not needed when preferredWorkerId is given
    const result = await resolveWorkerId(mockTrpc, "worker-123");
    expect(result).toBe("worker-123");
  });

  it("auto-discovers first available worker", async () => {
    const mockTrpc = {
      agent: {
        list: {
          query: async () => ({
            workers: [
              { workerId: "auto-worker-1", name: "Worker 1", tools: [], skills: [], connected: true },
              { workerId: "auto-worker-2", name: "Worker 2", tools: [], skills: [], connected: true },
            ],
          }),
        },
      },
    } as any;

    const result = await resolveWorkerId(mockTrpc);
    expect(result).toBe("auto-worker-1");
  });

  it("throws when no workers connected", async () => {
    const mockTrpc = {
      agent: {
        list: {
          query: async () => ({ workers: [] }),
        },
      },
    } as any;

    await expect(resolveWorkerId(mockTrpc)).rejects.toThrow("No workers connected");
  });

  it("selects first worker from many without preferred", async () => {
    const mockTrpc = {
      agent: {
        list: {
          query: async () => ({
            workers: [
              { workerId: "w-a", name: "A", connected: true },
              { workerId: "w-b", name: "B", connected: true },
              { workerId: "w-c", name: "C", connected: true },
            ],
          }),
        },
      },
    } as any;

    const result = await resolveWorkerId(mockTrpc);
    expect(result).toBe("w-a");
  });

  it("does not call agent.list when preferred ID is given", async () => {
    const queryMock = mock(async () => ({ workers: [] }));
    const mockTrpc = {
      agent: { list: { query: queryMock } },
    } as any;

    await resolveWorkerId(mockTrpc, "preferred-1");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("propagates query errors", async () => {
    const mockTrpc = {
      agent: {
        list: {
          query: async () => {
            throw new Error("Connection refused");
          },
        },
      },
    } as any;

    await expect(resolveWorkerId(mockTrpc)).rejects.toThrow("Connection refused");
  });
});

describe("subscribeToEvents", () => {
  it("subscribes to agent events for a session", () => {
    const unsubMock = mock(() => {});
    const subscribeMock = mock(() => ({ unsubscribe: unsubMock }));
    const mockTrpc = {
      agent: {
        onEvents: { subscribe: subscribeMock },
      },
    } as any;

    const onEvent = mock(() => {});
    const unsub = subscribeToEvents(mockTrpc, "session-1", onEvent);

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0][0]).toEqual({ sessionId: "session-1" });

    // Verify unsubscribe works
    unsub();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });

  it("forwards events to the onEvent callback", () => {
    let capturedOnData: ((event: any) => void) | null = null;
    const subscribeMock = mock((_input: any, opts: any) => {
      capturedOnData = opts.onData;
      return { unsubscribe: () => {} };
    });
    const mockTrpc = {
      agent: {
        onEvents: { subscribe: subscribeMock },
      },
    } as any;

    const events: any[] = [];
    subscribeToEvents(mockTrpc, "session-1", (e) => events.push(e));

    // Simulate events
    capturedOnData!({ type: "status_change", status: "streaming" });
    capturedOnData!({ type: "content_delta", delta: "hi", content: "hi" });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("status_change");
    expect(events[1].type).toBe("content_delta");
  });

  it("forwards errors to the onError callback", () => {
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribeMock = mock((_input: any, opts: any) => {
      capturedOnError = opts.onError;
      return { unsubscribe: () => {} };
    });
    const mockTrpc = {
      agent: {
        onEvents: { subscribe: subscribeMock },
      },
    } as any;

    const errors: unknown[] = [];
    subscribeToEvents(mockTrpc, "session-1", () => {}, (err) => errors.push(err));

    capturedOnError!(new Error("subscription failed"));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscription failed");
  });

  it("does not throw when onError is omitted and error occurs", () => {
    let capturedOnError: ((err: unknown) => void) | null = null;
    const subscribeMock = mock((_input: any, opts: any) => {
      capturedOnError = opts.onError;
      return { unsubscribe: () => {} };
    });
    const mockTrpc = {
      agent: {
        onEvents: { subscribe: subscribeMock },
      },
    } as any;

    subscribeToEvents(mockTrpc, "session-1", () => {});

    // Should not throw
    expect(() => capturedOnError!(new Error("ignored"))).not.toThrow();
  });
});
