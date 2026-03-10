import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionEventDispatcher } from "../src/event-dispatcher.js";
import type { AgentEvent } from "@molf-ai/protocol";

/**
 * Create a mock ServerConnection whose `subscribeToEvents` (via `connection.trpc`)
 * is controlled by the test. The mock captures the onData/onError callbacks
 * so we can push events from the test side.
 */
function createMockConnection() {
  const subscriptions = new Map<string, { onData: (e: AgentEvent) => void; onError?: (err: unknown) => void; unsub: ReturnType<typeof vi.fn> }>();

  return {
    subscriptions,
    connection: {
      trpc: {
        agent: {
          onEvents: {
            subscribe: (input: { sessionId: string }, opts: { onData: (e: AgentEvent) => void; onError?: (err: unknown) => void }) => {
              const unsub = vi.fn(() => {
                subscriptions.delete(input.sessionId);
              });
              subscriptions.set(input.sessionId, { onData: opts.onData, onError: opts.onError, unsub });
              return { unsubscribe: unsub };
            },
          },
        },
      },
    } as any,
  };
}

describe("SessionEventDispatcher", () => {
  let mockConn: ReturnType<typeof createMockConnection>;
  let dispatcher: SessionEventDispatcher;

  beforeEach(() => {
    mockConn = createMockConnection();
    dispatcher = new SessionEventDispatcher(mockConn.connection);
  });

  it("subscribe creates a tRPC subscription", () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    expect(mockConn.subscriptions.has("s-1")).toBe(true);
  });

  it("forwards events to the registered handler", () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    const event: AgentEvent = { type: "status_change", status: "streaming" };
    mockConn.subscriptions.get("s-1")!.onData(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("fans out events to multiple handlers on the same session", () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-1", handler2);

    const event: AgentEvent = { type: "status_change", status: "idle" };
    mockConn.subscriptions.get("s-1")!.onData(event);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("does not create duplicate tRPC subscriptions for the same session", () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));
    dispatcher.subscribe("s-1", vi.fn(() => {}));

    // Only one tRPC subscription should exist
    expect(mockConn.subscriptions.size).toBe(1);
  });

  it("unsubscribing a handler removes it from fan-out", () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    const unsub1 = dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-1", handler2);

    unsub1();

    const event: AgentEvent = { type: "status_change", status: "streaming" };
    mockConn.subscriptions.get("s-1")!.onData(event);

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing the last handler cancels the tRPC subscription", () => {
    const handler = vi.fn(() => {});
    const unsub = dispatcher.subscribe("s-1", handler);

    unsub();

    // tRPC unsubscribe should have been called
    expect(mockConn.subscriptions.has("s-1")).toBe(false);
  });

  it("unsubscribing twice is a no-op", () => {
    const handler = vi.fn(() => {});
    const unsub = dispatcher.subscribe("s-1", handler);

    unsub();
    unsub(); // Should not throw
  });

  it("late handler receives subsequent events", () => {
    const earlyHandler = vi.fn(() => {});
    dispatcher.subscribe("s-1", earlyHandler);

    // Push an event before the late handler subscribes
    mockConn.subscriptions.get("s-1")!.onData({ type: "status_change", status: "streaming" });

    const lateHandler = vi.fn(() => {});
    dispatcher.subscribe("s-1", lateHandler);

    // Late handler should NOT have received the first event
    expect(lateHandler).not.toHaveBeenCalled();

    // But subsequent events should go to both
    const event2: AgentEvent = { type: "status_change", status: "idle" };
    mockConn.subscriptions.get("s-1")!.onData(event2);

    expect(earlyHandler).toHaveBeenCalledTimes(2);
    expect(lateHandler).toHaveBeenCalledTimes(1);
    expect(lateHandler).toHaveBeenCalledWith(event2);
  });

  it("cleanup cancels all tRPC subscriptions", () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));
    dispatcher.subscribe("s-2", vi.fn(() => {}));

    expect(mockConn.subscriptions.size).toBe(2);

    dispatcher.cleanup();

    // Both subscriptions should have been cancelled
    expect(mockConn.subscriptions.size).toBe(0);
  });

  it("cleanup followed by subscribe creates fresh subscription", () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));
    dispatcher.cleanup();

    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    expect(mockConn.subscriptions.has("s-1")).toBe(true);

    mockConn.subscriptions.get("s-1")!.onData({ type: "status_change", status: "streaming" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("independent sessions do not interfere", () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-2", handler2);

    mockConn.subscriptions.get("s-1")!.onData({ type: "status_change", status: "streaming" });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
  });
});
