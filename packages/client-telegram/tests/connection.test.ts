import { describe, it, expect, mock } from "bun:test";
import { resolveWorkerId, subscribeToEvents } from "../src/connection.js";

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
              { workerId: "w-a", name: "A" },
              { workerId: "w-b", name: "B" },
              { workerId: "w-c", name: "C" },
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
