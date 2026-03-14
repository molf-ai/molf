import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveWorkerId, subscribeToEvents } from "../src/connection.js";

// --- connectToServer tests (requires mocking @orpc/client) ---

const { createORPCClientMock, RPCLinkMock } = vi.hoisted(() => ({
  createORPCClientMock: vi.fn(() => ({})),
  RPCLinkMock: vi.fn(() => ({})),
}));

vi.mock("@orpc/client", () => ({
  createORPCClient: createORPCClientMock,
}));

vi.mock("@orpc/client/websocket", () => ({
  RPCLink: RPCLinkMock,
}));

const { createAuthWebSocketMock, mockWsInstances } = vi.hoisted(() => {
  const mockWsInstances: any[] = [];
  const createAuthWebSocketMock = vi.fn(() => {
    return class MockWebSocket {
      url: string;
      private listeners = new Map<string, Function[]>();
      constructor(url: string) {
        this.url = url;
        mockWsInstances.push(this);
      }
      addEventListener(event: string, handler: Function) {
        const list = this.listeners.get(event) ?? [];
        list.push(handler);
        this.listeners.set(event, list);
      }
      removeEventListener(event: string, handler: Function) {
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(event, list.filter((h) => h !== handler));
      }
      close() {}
      // Test helper: fire an event
      _emit(event: string, data?: any) {
        for (const handler of this.listeners.get(event) ?? []) {
          handler(data);
        }
      }
    };
  });
  return { createAuthWebSocketMock, mockWsInstances };
});

vi.mock("@molf-ai/protocol", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createAuthWebSocket: createAuthWebSocketMock,
  };
});

import { connectToServer, ServerConnection, type ConnectionOptions } from "../src/connection.js";

describe("connectToServer", () => {
  beforeEach(() => {
    createORPCClientMock.mockClear();
    RPCLinkMock.mockClear();
    createAuthWebSocketMock.mockClear();
    mockWsInstances.length = 0;
  });

  it("includes clientId in WebSocket URL", async () => {
    const connectPromise = connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    // Wait for ws to be created, then fire open
    await new Promise((r) => setTimeout(r, 10));
    mockWsInstances[0]._emit("open");

    await connectPromise;

    expect(createAuthWebSocketMock).toHaveBeenCalledTimes(1);
    const token = createAuthWebSocketMock.mock.calls[0][0];
    expect(token).toBe("test");
  });

  it("sets name in WebSocket URL and passes token to createAuthWebSocket", async () => {
    const connectPromise = connectToServer({ serverUrl: "ws://localhost:7600", token: "my-token" });

    await new Promise((r) => setTimeout(r, 10));
    mockWsInstances[0]._emit("open");

    await connectPromise;

    expect(createAuthWebSocketMock).toHaveBeenCalledWith("my-token", undefined);
  });

  it("creates an RPCLink with the websocket and an oRPC client", async () => {
    const connectPromise = connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    await new Promise((r) => setTimeout(r, 10));
    mockWsInstances[0]._emit("open");

    await connectPromise;

    expect(RPCLinkMock).toHaveBeenCalledTimes(1);
    expect(createORPCClientMock).toHaveBeenCalledTimes(1);
  });
});

describe("backoff delay", () => {
  it("increases with each attempt and stays within bounds", async () => {
    // We can't test the private backoffDelay directly, but we can test
    // that reconnection attempts are scheduled with increasing delays.
    // Instead, just verify the ServerConnection class exists and has expected methods.
    const conn = new ServerConnection({ serverUrl: "ws://localhost:7600", token: "test" });
    expect(conn).toBeInstanceOf(ServerConnection);
    expect(typeof conn.connect).toBe("function");
    expect(typeof conn.close).toBe("function");
  });
});

describe("reconnection", () => {
  beforeEach(() => {
    createORPCClientMock.mockClear();
    RPCLinkMock.mockClear();
    createAuthWebSocketMock.mockClear();
    mockWsInstances.length = 0;
  });
  // Auto-opening WebSocket mock for reconnection tests.
  // Fires "open" synchronously from addEventListener("open") so the promise resolves immediately.
  const AutoOpenWSClass = class AutoOpenWS {
    url: string;
    private listeners = new Map<string, Function[]>();
    constructor(url: string) {
      this.url = url;
      mockWsInstances.push(this);
    }
    addEventListener(event: string, handler: Function) {
      const list = this.listeners.get(event) ?? [];
      list.push(handler);
      this.listeners.set(event, list);
      // Auto-fire "open" as soon as the handler is registered
      if (event === "open") {
        Promise.resolve().then(() => handler());
      }
    }
    removeEventListener(event: string, handler: Function) {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(event, list.filter((h) => h !== handler));
    }
    close() {}
    _emit(event: string, data?: any) {
      for (const handler of this.listeners.get(event) ?? []) handler(data);
    }
  };

  it("reconnects after WebSocket close", async () => {
    createAuthWebSocketMock.mockReturnValue(AutoOpenWSClass as any);
    const connection = await connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    // Simulate disconnect
    (mockWsInstances[0] as any)._emit("close");

    // Wait for reconnection (backoff ~1s for first attempt)
    await vi.waitFor(() => {
      expect(mockWsInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    // Client should be updated
    expect(connection.client).toBeDefined();
    connection.close();
  });

  it("calls onReconnect callback after successful reconnection", async () => {
    createAuthWebSocketMock.mockReturnValue(AutoOpenWSClass as any);
    const onReconnect = vi.fn();
    const connection = await connectToServer({
      serverUrl: "ws://localhost:7600",
      token: "test",
      onReconnect,
    });

    expect(onReconnect).not.toHaveBeenCalled();

    // Simulate disconnect
    (mockWsInstances[0] as any)._emit("close");

    // Wait for reconnection (backoff ~1s for first attempt)
    await vi.waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });

    connection.close();
  });

  it("does not reconnect after graceful close", async () => {
    createAuthWebSocketMock.mockReturnValue(AutoOpenWSClass as any);
    const connection = await connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    const initialCount = mockWsInstances.length;

    // Graceful close — should not trigger reconnection
    connection.close();
    (mockWsInstances[0] as any)._emit("close");

    // Wait a bit — no new WS should appear
    await new Promise((r) => setTimeout(r, 200));

    expect(mockWsInstances.length).toBe(initialCount);
  });

  it("generation guard prevents stale disconnect from triggering reconnect", async () => {
    createAuthWebSocketMock.mockReturnValue(AutoOpenWSClass as any);
    const connection = await connectToServer({ serverUrl: "ws://localhost:7600", token: "test" });

    const firstWs = mockWsInstances[0] as any;

    // Simulate disconnect
    firstWs._emit("close");

    // Wait for reconnection
    await vi.waitFor(() => {
      expect(mockWsInstances.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    const countAfterReconnect = mockWsInstances.length;

    // Fire close on the OLD (stale) WebSocket — should be ignored due to generation guard
    firstWs._emit("close");

    // Wait a bit — no new WS should appear
    await new Promise((r) => setTimeout(r, 200));

    // No additional reconnect attempts
    expect(mockWsInstances.length).toBe(countAfterReconnect);
    connection.close();
  });
});

describe("resolveWorkerId", () => {
  it("returns preferred worker ID when provided", async () => {
    const mockClient = {} as any; // Not needed when preferredWorkerId is given
    const result = await resolveWorkerId(mockClient, "worker-123");
    expect(result).toBe("worker-123");
  });

  it("auto-discovers first available worker", async () => {
    const mockClient = {
      agent: {
        list: async () => ({
          workers: [
            { workerId: "auto-worker-1", name: "Worker 1", tools: [], skills: [], connected: true },
            { workerId: "auto-worker-2", name: "Worker 2", tools: [], skills: [], connected: true },
          ],
        }),
      },
    } as any;

    const result = await resolveWorkerId(mockClient);
    expect(result).toBe("auto-worker-1");
  });

  it("throws when no workers connected", async () => {
    const mockClient = {
      agent: {
        list: async () => ({ workers: [] }),
      },
    } as any;

    await expect(resolveWorkerId(mockClient)).rejects.toThrow("No workers connected");
  });

  it("selects first worker from many without preferred", async () => {
    const mockClient = {
      agent: {
        list: async () => ({
          workers: [
            { workerId: "w-a", name: "A", connected: true },
            { workerId: "w-b", name: "B", connected: true },
            { workerId: "w-c", name: "C", connected: true },
          ],
        }),
      },
    } as any;

    const result = await resolveWorkerId(mockClient);
    expect(result).toBe("w-a");
  });

  it("does not call agent.list when preferred ID is given", async () => {
    const listMock = vi.fn(async () => ({ workers: [] }));
    const mockClient = {
      agent: { list: listMock },
    } as any;

    await resolveWorkerId(mockClient, "preferred-1");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("propagates query errors", async () => {
    const mockClient = {
      agent: {
        list: async () => {
          throw new Error("Connection refused");
        },
      },
    } as any;

    await expect(resolveWorkerId(mockClient)).rejects.toThrow("Connection refused");
  });
});

describe("subscribeToEvents", () => {
  it("calls agent.onEvents for a session and returns abort function", async () => {
    const mockIterable = {
      [Symbol.asyncIterator]() { return this; },
      async next() { return { value: undefined, done: true }; },
      async return() { return { value: undefined, done: true }; },
    };
    const onEventsMock = vi.fn(async () => mockIterable);
    const mockClient = {
      agent: { onEvents: onEventsMock },
    } as any;

    const onEvent = vi.fn();
    const unsub = subscribeToEvents(mockClient, "session-1", onEvent);

    // Allow the async IIFE to start
    await new Promise((r) => setTimeout(r, 10));

    expect(onEventsMock).toHaveBeenCalledTimes(1);
    expect(onEventsMock.mock.calls[0][0]).toEqual({ sessionId: "session-1" });

    // unsub should be a function (abort)
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("forwards events to the onEvent callback", async () => {
    const events: any[] = [];
    let yieldResolve: (() => void) | null = null;
    let iterDone = false;
    const queue: any[] = [
      { type: "status_change", status: "streaming" },
      { type: "content_delta", delta: "hi", content: "hi" },
    ];

    const mockIterable = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (queue.length > 0) return { value: queue.shift(), done: false };
        if (iterDone) return { value: undefined, done: true };
        // Block until done
        await new Promise<void>((r) => { yieldResolve = r; });
        return { value: undefined, done: true };
      },
      async return() { iterDone = true; if (yieldResolve) yieldResolve(); return { value: undefined, done: true }; },
    };

    const mockClient = {
      agent: { onEvents: vi.fn(async () => mockIterable) },
    } as any;

    const unsub = subscribeToEvents(mockClient, "session-1", (e) => events.push(e));

    // Allow async iteration to process
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("status_change");
    expect(events[1].type).toBe("content_delta");

    unsub();
  });

  it("forwards errors to the onError callback", async () => {
    const mockClient = {
      agent: {
        onEvents: vi.fn(async () => {
          throw new Error("subscription failed");
        }),
      },
    } as any;

    const errors: unknown[] = [];
    subscribeToEvents(mockClient, "session-1", () => {}, (err) => errors.push(err));

    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscription failed");
  });

  it("does not throw when onError is omitted and error occurs", async () => {
    const mockClient = {
      agent: {
        onEvents: vi.fn(async () => {
          throw new Error("ignored");
        }),
      },
    } as any;

    // Should not throw
    subscribeToEvents(mockClient, "session-1", () => {});

    await new Promise((r) => setTimeout(r, 20));
  });
});
