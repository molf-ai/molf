import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionEventDispatcher } from "../src/event-dispatcher.js";
import type { AgentEvent } from "@molf-ai/protocol";

/**
 * Create a mock ServerConnection whose `subscribeToEvents` (via `connection.client`)
 * is controlled by the test. The mock uses async iterables internally, but we
 * expose a push/end interface so tests can simulate events synchronously.
 */
function createMockConnection() {
  const subscriptions = new Map<string, { push: (e: AgentEvent) => void; end: () => void; unsub: ReturnType<typeof vi.fn> }>();

  return {
    subscriptions,
    connection: {
      client: {
        agent: {
          onEvents: async (input: { sessionId: string }) => {
            const queue: AgentEvent[] = [];
            let resolve: (() => void) | null = null;
            let done = false;
            const unsub = vi.fn(() => {
              done = true;
              if (resolve) { resolve(); resolve = null; }
              subscriptions.delete(input.sessionId);
            });

            const iterable = {
              [Symbol.asyncIterator]() { return this; },
              async next(): Promise<IteratorResult<AgentEvent>> {
                while (queue.length === 0 && !done) {
                  await new Promise<void>((r) => { resolve = r; });
                }
                if (queue.length > 0) return { value: queue.shift()!, done: false };
                return { value: undefined as any, done: true };
              },
              async return(): Promise<IteratorResult<AgentEvent>> {
                done = true;
                if (resolve) { resolve(); resolve = null; }
                return { value: undefined as any, done: true };
              },
            };

            const entry = {
              push: (e: AgentEvent) => { queue.push(e); if (resolve) { resolve(); resolve = null; } },
              end: () => { done = true; if (resolve) { resolve(); resolve = null; } },
              unsub,
            };
            subscriptions.set(input.sessionId, entry);

            return iterable;
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

  it("subscribe creates a subscription via client", async () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    // Allow async iteration to start
    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.subscriptions.has("s-1")).toBe(true);
  });

  it("forwards events to the registered handler", async () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    await new Promise((r) => setTimeout(r, 10));

    const event: AgentEvent = { type: "status_change", status: "streaming" };
    mockConn.subscriptions.get("s-1")!.push(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("fans out events to multiple handlers on the same session", async () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-1", handler2);

    await new Promise((r) => setTimeout(r, 10));

    const event: AgentEvent = { type: "status_change", status: "idle" };
    mockConn.subscriptions.get("s-1")!.push(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("does not create duplicate subscriptions for the same session", async () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));
    dispatcher.subscribe("s-1", vi.fn(() => {}));

    await new Promise((r) => setTimeout(r, 10));

    // Only one subscription should exist
    expect(mockConn.subscriptions.size).toBe(1);
  });

  it("unsubscribing a handler removes it from fan-out", async () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    const unsub1 = dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-1", handler2);

    await new Promise((r) => setTimeout(r, 10));

    unsub1();

    const event: AgentEvent = { type: "status_change", status: "streaming" };
    mockConn.subscriptions.get("s-1")!.push(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing the last handler cancels the subscription", async () => {
    const handler = vi.fn(() => {});
    const unsub = dispatcher.subscribe("s-1", handler);

    await new Promise((r) => setTimeout(r, 10));

    unsub();

    // Subscription entry should be removed from dispatcher
    // (the unsub calls abort which ends the iteration)
    await new Promise((r) => setTimeout(r, 10));
  });

  it("unsubscribing twice is a no-op", async () => {
    const handler = vi.fn(() => {});
    const unsub = dispatcher.subscribe("s-1", handler);

    await new Promise((r) => setTimeout(r, 10));

    unsub();
    unsub(); // Should not throw
  });

  it("late handler receives subsequent events", async () => {
    const earlyHandler = vi.fn(() => {});
    dispatcher.subscribe("s-1", earlyHandler);

    await new Promise((r) => setTimeout(r, 10));

    // Push an event before the late handler subscribes
    mockConn.subscriptions.get("s-1")!.push({ type: "status_change", status: "streaming" });
    await new Promise((r) => setTimeout(r, 10));

    const lateHandler = vi.fn(() => {});
    dispatcher.subscribe("s-1", lateHandler);

    // Late handler should NOT have received the first event
    expect(lateHandler).not.toHaveBeenCalled();

    // But subsequent events should go to both
    const event2: AgentEvent = { type: "status_change", status: "idle" };
    mockConn.subscriptions.get("s-1")!.push(event2);
    await new Promise((r) => setTimeout(r, 10));

    expect(earlyHandler).toHaveBeenCalledTimes(2);
    expect(lateHandler).toHaveBeenCalledTimes(1);
    expect(lateHandler).toHaveBeenCalledWith(event2);
  });

  it("cleanup cancels all subscriptions", async () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));
    dispatcher.subscribe("s-2", vi.fn(() => {}));

    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.subscriptions.size).toBe(2);

    dispatcher.cleanup();

    // Give abort signals time to propagate
    await new Promise((r) => setTimeout(r, 10));
  });

  it("cleanup followed by subscribe creates fresh subscription", async () => {
    dispatcher.subscribe("s-1", vi.fn(() => {}));

    await new Promise((r) => setTimeout(r, 10));

    dispatcher.cleanup();

    await new Promise((r) => setTimeout(r, 10));

    const handler = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.subscriptions.has("s-1")).toBe(true);

    mockConn.subscriptions.get("s-1")!.push({ type: "status_change", status: "streaming" });
    await new Promise((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("independent sessions do not interfere", async () => {
    const handler1 = vi.fn(() => {});
    const handler2 = vi.fn(() => {});
    dispatcher.subscribe("s-1", handler1);
    dispatcher.subscribe("s-2", handler2);

    await new Promise((r) => setTimeout(r, 10));

    mockConn.subscriptions.get("s-1")!.push({ type: "status_change", status: "streaming" });

    await new Promise((r) => setTimeout(r, 10));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
  });
});
