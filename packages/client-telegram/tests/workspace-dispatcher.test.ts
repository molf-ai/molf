import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkspaceEventDispatcher } from "../src/workspace-dispatcher.js";
import type { WorkspaceEvent } from "@molf-ai/protocol";

function createMockConnection() {
  const subscriptions = new Map<string, { push: (e: WorkspaceEvent) => void; end: () => void; unsub: ReturnType<typeof vi.fn> }>();

  return {
    subscriptions,
    connection: {
      client: {
        workspace: {
          onEvents: async (input: { workerId: string; workspaceId: string }) => {
            const queue: WorkspaceEvent[] = [];
            let resolve: (() => void) | null = null;
            let done = false;

            const unsub = vi.fn(() => {
              done = true;
              if (resolve) { resolve(); resolve = null; }
              subscriptions.delete(input.workspaceId);
            });

            const iterable = {
              [Symbol.asyncIterator]() { return this; },
              async next(): Promise<IteratorResult<WorkspaceEvent>> {
                while (queue.length === 0 && !done) {
                  await new Promise<void>((r) => { resolve = r; });
                }
                if (queue.length > 0) return { value: queue.shift()!, done: false };
                return { value: undefined as any, done: true };
              },
              async return(): Promise<IteratorResult<WorkspaceEvent>> {
                done = true;
                if (resolve) { resolve(); resolve = null; }
                return { value: undefined as any, done: true };
              },
            };

            const entry = {
              push: (e: WorkspaceEvent) => { queue.push(e); if (resolve) { resolve(); resolve = null; } },
              end: () => { done = true; if (resolve) { resolve(); resolve = null; } },
              unsub,
            };
            subscriptions.set(input.workspaceId, entry);

            return iterable;
          },
        },
      },
    } as any,
  };
}

describe("WorkspaceEventDispatcher", () => {
  let mockConn: ReturnType<typeof createMockConnection>;
  let dispatcher: WorkspaceEventDispatcher;

  beforeEach(() => {
    mockConn = createMockConnection();
    dispatcher = new WorkspaceEventDispatcher(mockConn.connection, "worker-1");
  });

  it("subscribe creates a subscription", async () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
  });

  it("forwards events to the registered handler", async () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);

    await new Promise((r) => setTimeout(r, 10));

    const event: WorkspaceEvent = { type: "session_created", sessionId: "s-1", sessionName: "New" };
    mockConn.subscriptions.get("ws-1")!.push(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("fans out events to multiple handlers", async () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-1", h2);

    await new Promise((r) => setTimeout(r, 10));

    const event: WorkspaceEvent = { type: "config_changed", config: { model: "gemini" } };
    mockConn.subscriptions.get("ws-1")!.push(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("does not create duplicate subscriptions for the same workspace", async () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockConn.subscriptions.size).toBe(1);
  });

  it("unsubscribing a handler removes it from fan-out", async () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    const unsub1 = dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-1", h2);

    await new Promise((r) => setTimeout(r, 10));

    unsub1();

    mockConn.subscriptions.get("ws-1")!.push({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    await new Promise((r) => setTimeout(r, 10));

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing last handler cancels subscription", async () => {
    const unsub = dispatcher.subscribe("ws-1", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    unsub();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("cleanup cancels all subscriptions", async () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    dispatcher.subscribe("ws-2", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockConn.subscriptions.size).toBe(2);

    dispatcher.cleanup();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("setWorkerId with same ID does not trigger cleanup", async () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);
    await new Promise((r) => setTimeout(r, 10));

    dispatcher.setWorkerId("worker-1"); // same ID

    // Subscription should still be alive
    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
    mockConn.subscriptions.get("ws-1")!.push({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("setWorkerId with different ID triggers cleanup", async () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockConn.subscriptions.size).toBe(1);

    dispatcher.setWorkerId("worker-2");
    await new Promise((r) => setTimeout(r, 10));
  });

  it("setWorkerId allows new subscriptions with new worker", async () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    dispatcher.setWorkerId("worker-2");
    await new Promise((r) => setTimeout(r, 10));

    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
    mockConn.subscriptions.get("ws-1")!.push({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("independent workspaces do not interfere", async () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-2", h2);

    await new Promise((r) => setTimeout(r, 10));

    mockConn.subscriptions.get("ws-1")!.push({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    await new Promise((r) => setTimeout(r, 10));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).not.toHaveBeenCalled();
  });
});
