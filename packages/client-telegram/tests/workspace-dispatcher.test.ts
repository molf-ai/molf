import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkspaceEventDispatcher } from "../src/workspace-dispatcher.js";
import type { WorkspaceEvent } from "@molf-ai/protocol";

function createMockConnection() {
  const subscriptions = new Map<string, { onData: (e: WorkspaceEvent) => void; onError?: (err: unknown) => void; unsub: ReturnType<typeof vi.fn> }>();

  return {
    subscriptions,
    connection: {
      trpc: {
        workspace: {
          onEvents: {
            subscribe: (input: { workerId: string; workspaceId: string }, opts: { onData: (e: WorkspaceEvent) => void; onError?: (err: unknown) => void }) => {
              const unsub = vi.fn(() => {
                subscriptions.delete(input.workspaceId);
              });
              subscriptions.set(input.workspaceId, { onData: opts.onData, onError: opts.onError, unsub });
              return { unsubscribe: unsub };
            },
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

  it("subscribe creates a tRPC subscription", () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
  });

  it("forwards events to the registered handler", () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);

    const event: WorkspaceEvent = { type: "session_created", sessionId: "s-1", sessionName: "New" };
    mockConn.subscriptions.get("ws-1")!.onData(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("fans out events to multiple handlers", () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-1", h2);

    const event: WorkspaceEvent = { type: "config_changed", config: { model: "gemini" } };
    mockConn.subscriptions.get("ws-1")!.onData(event);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("does not create duplicate subscriptions for the same workspace", () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    expect(mockConn.subscriptions.size).toBe(1);
  });

  it("unsubscribing a handler removes it from fan-out", () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    const unsub1 = dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-1", h2);

    unsub1();

    mockConn.subscriptions.get("ws-1")!.onData({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing last handler cancels tRPC subscription", () => {
    const unsub = dispatcher.subscribe("ws-1", vi.fn(() => {}));
    unsub();
    expect(mockConn.subscriptions.has("ws-1")).toBe(false);
  });

  it("cleanup cancels all subscriptions", () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    dispatcher.subscribe("ws-2", vi.fn(() => {}));
    expect(mockConn.subscriptions.size).toBe(2);

    dispatcher.cleanup();
    expect(mockConn.subscriptions.size).toBe(0);
  });

  it("setWorkerId with same ID does not trigger cleanup", () => {
    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);

    dispatcher.setWorkerId("worker-1"); // same ID

    // Subscription should still be alive
    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
    mockConn.subscriptions.get("ws-1")!.onData({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("setWorkerId with different ID triggers cleanup", () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    expect(mockConn.subscriptions.size).toBe(1);

    dispatcher.setWorkerId("worker-2");
    expect(mockConn.subscriptions.size).toBe(0);
  });

  it("setWorkerId allows new subscriptions with new worker", () => {
    dispatcher.subscribe("ws-1", vi.fn(() => {}));
    dispatcher.setWorkerId("worker-2");

    const handler = vi.fn(() => {});
    dispatcher.subscribe("ws-1", handler);

    expect(mockConn.subscriptions.has("ws-1")).toBe(true);
    mockConn.subscriptions.get("ws-1")!.onData({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("independent workspaces do not interfere", () => {
    const h1 = vi.fn(() => {});
    const h2 = vi.fn(() => {});
    dispatcher.subscribe("ws-1", h1);
    dispatcher.subscribe("ws-2", h2);

    mockConn.subscriptions.get("ws-1")!.onData({ type: "session_created", sessionId: "s-1", sessionName: "X" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).not.toHaveBeenCalled();
  });
});
