import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AgentEvent } from "@molf-ai/protocol";

// ---------------------------------------------------------------------------
// Mock state — declared before mock.module so closures capture these refs
// ---------------------------------------------------------------------------

let onDataCallback: ((event: AgentEvent) => void) | null = null;
let onErrorCallback: ((err: unknown) => void) | null = null;
let subscriptionUnsubscribe = mock(() => {});

function createMockTrpc() {
  return {
    session: {
      create: { mutate: mock(async (_input: any) => ({ sessionId: "new-session-1", name: "Session", workerId: "w1", createdAt: Date.now() })) },
      load: { mutate: mock(async (_input: any) => ({ sessionId: _input.sessionId, name: "Loaded", workerId: "w1", messages: [] })) },
      list: { query: mock(async () => ({ sessions: [], total: 0 })) },
      rename: { mutate: mock(async (_input: any) => ({ renamed: true })) },
      delete: { mutate: mock(async (_input: any) => ({ deleted: true })) },
    },
    agent: {
      list: { query: mock(async () => ({ workers: [{ workerId: "w1", name: "worker-1", tools: [], skills: [], connected: true }] })) },
      prompt: { mutate: mock(async (_input: any) => ({ messageId: "msg-1" })) },
      abort: { mutate: mock(async (_input: any) => ({ aborted: true })) },
      onEvents: {
        subscribe: mock((_input: any, opts: any) => {
          onDataCallback = opts.onData;
          onErrorCallback = opts.onError;
          return { unsubscribe: subscriptionUnsubscribe };
        }),
      },
    },
    tool: {
      approve: { mutate: mock(async (_input: any) => ({ applied: true })) },
      deny: { mutate: mock(async (_input: any) => ({ applied: true })) },
    },
  };
}

let mockTrpc = createMockTrpc();
let mockWsClient = { close: mock(() => {}) };

// ---------------------------------------------------------------------------
// Mock @trpc/client — MUST be before any import of use-server
// ---------------------------------------------------------------------------

mock.module("../src/trpc-client.js", () => ({
  createWSClient: mock(() => mockWsClient),
  createTRPCClient: mock(() => mockTrpc),
  wsLink: mock(() => "mock-link"),
}));

// ---------------------------------------------------------------------------
// Dynamic import of the module under test (after mock.module)
// ---------------------------------------------------------------------------

const { useServer } = await import("../src/hooks/use-server.js");
type UseServerReturn = ReturnType<typeof useServer>;

// ---------------------------------------------------------------------------
// Static imports for rendering
// ---------------------------------------------------------------------------

import { render } from "ink-testing-library";
import React from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderHook<T>(fn: () => T) {
  const result = { current: undefined as T };
  function Wrapper() {
    result.current = fn();
    return null;
  }
  const instance = render(React.createElement(Wrapper));
  return { result, ...instance };
}

async function waitFor(
  assertion: () => void,
  { timeout = 3000, interval = 10 } = {},
) {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

/** Flush microtasks + short sleep to let React/effects settle */
async function flushAsync(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let cleanup: (() => void) | null = null;

beforeEach(() => {
  mockTrpc = createMockTrpc();
  mockWsClient = { close: mock(() => {}) };
  onDataCallback = null;
  onErrorCallback = null;
  subscriptionUnsubscribe = mock(() => {});
});

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ---------------------------------------------------------------------------
// Helper to render the hook with defaults
// ---------------------------------------------------------------------------

function renderUseServer(overrides: Partial<Parameters<typeof useServer>[0]> = {}) {
  const opts = {
    url: "ws://127.0.0.1:7600",
    token: "test-token",
    ...overrides,
  };
  const hook = renderHook(() => useServer(opts));
  cleanup = hook.unmount;
  return hook;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useServer hook — initialization", () => {
  test("creates session when no sessionId provided and no existing sessions (worker discovery)", async () => {
    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("new-session-1");
    });

    // Should have discovered workers
    expect(mockTrpc.agent.list.query).toHaveBeenCalled();
    // Should have listed all sessions (no workerId filter, limit 1)
    expect(mockTrpc.session.list.query).toHaveBeenCalledWith({ limit: 1 });
    // No existing sessions — should have created a new one
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1" });
    // Should have subscribed to events
    expect(mockTrpc.agent.onEvents.subscribe).toHaveBeenCalled();
  });

  test("loads existing session when sessionId provided", async () => {
    const messages = [
      { id: "m1", role: "user", content: "hi", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "hello", timestamp: 1001 },
    ];
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "Loaded",
      workerId: "w1",
      messages,
    }));

    const { result } = renderUseServer({ sessionId: "existing-session" });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("existing-session");
    });

    expect(mockTrpc.session.load.mutate).toHaveBeenCalledWith({ sessionId: "existing-session" });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("hi");
    // Fetches workers to resolve worker name
    expect(mockTrpc.agent.list.query).toHaveBeenCalled();
  });

  test("sets error when no workers available", async () => {
    mockTrpc.agent.list.query.mockImplementation(async () => ({ workers: [] }));

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error!.message).toContain("No workers connected");
    expect(result.current.connected).toBe(false);
  });

  test("sets error when initSession throws", async () => {
    mockTrpc.agent.list.query.mockImplementation(async () => {
      throw new Error("Connection refused");
    });

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error!.message).toBe("Connection refused");
  });

  test("uses provided workerId, skips worker discovery", async () => {
    const { result } = renderUseServer({ workerId: "my-worker" });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    // Fetches workers to resolve worker name even when workerId is provided
    expect(mockTrpc.agent.list.query).toHaveBeenCalled();
    // Should have tried to list sessions for the provided worker
    expect(mockTrpc.session.list.query).toHaveBeenCalledWith({ workerId: "my-worker", limit: 1 });
    // No existing sessions — should create session with provided workerId
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "my-worker" });
  });

  test("restores most recent session when sessions exist for worker", async () => {
    const existingSessions = [
      { sessionId: "recent-session", name: "Recent", workerId: "w1", createdAt: 2000, lastActiveAt: 3000, messageCount: 2, active: false },
      { sessionId: "old-session", name: "Old", workerId: "w1", createdAt: 1000, lastActiveAt: 1500, messageCount: 1, active: false },
    ];
    const restoredMessages = [
      { id: "m1", role: "user", content: "restored msg", timestamp: 2000 },
      { id: "m2", role: "assistant", content: "restored reply", timestamp: 2001 },
    ];

    mockTrpc.session.list.query.mockImplementation(async () => ({ sessions: existingSessions, total: existingSessions.length }));
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "Recent",
      workerId: "w1",
      messages: restoredMessages,
    }));

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("recent-session");
    });

    // Should have listed all sessions (no workerId filter, limit 1)
    expect(mockTrpc.session.list.query).toHaveBeenCalledWith({ limit: 1 });
    // Should have loaded the most recent session (first in list)
    expect(mockTrpc.session.load.mutate).toHaveBeenCalledWith({ sessionId: "recent-session" });
    // Should NOT have created a new session
    expect(mockTrpc.session.create.mutate).not.toHaveBeenCalled();
    // Messages should be restored
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("restored msg");
    expect(result.current.messages[1].content).toBe("restored reply");
    // Should have subscribed to events
    expect(mockTrpc.agent.onEvents.subscribe).toHaveBeenCalled();
  });

  test("creates new session when session.list throws", async () => {
    mockTrpc.session.list.query.mockImplementation(async () => {
      throw new Error("list failed");
    });

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("new-session-1");
    });

    // session.list threw — should have fallen back to creating a new session
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1" });
    // Should have subscribed to events
    expect(mockTrpc.agent.onEvents.subscribe).toHaveBeenCalled();
  });

  test("restores session from any worker when no workerId provided", async () => {
    // Two workers available
    mockTrpc.agent.list.query.mockImplementation(async () => ({
      workers: [
        { workerId: "w1", name: "worker-1", tools: [], skills: [], connected: true },
        { workerId: "w2", name: "worker-2", tools: [], skills: [], connected: true },
      ],
    }));

    // Sessions from different workers — most recent belongs to w2
    const existingSessions = [
      { sessionId: "w2-session", name: "W2 Session", workerId: "w2", createdAt: 3000, lastActiveAt: 5000, messageCount: 1, active: false },
      { sessionId: "w1-session", name: "W1 Session", workerId: "w1", createdAt: 1000, lastActiveAt: 2000, messageCount: 2, active: false },
    ];
    const restoredMessages = [
      { id: "m1", role: "user", content: "msg from w2 session", timestamp: 3000 },
    ];

    mockTrpc.session.list.query.mockImplementation(async () => ({ sessions: existingSessions, total: existingSessions.length }));
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "W2 Session",
      workerId: "w2",
      messages: restoredMessages,
    }));

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("w2-session");
    });

    // Should have listed all sessions without workerId filter (limit 1)
    expect(mockTrpc.session.list.query).toHaveBeenCalledWith({ limit: 1 });
    // Should have loaded the most recent session (from w2, not w1)
    expect(mockTrpc.session.load.mutate).toHaveBeenCalledWith({ sessionId: "w2-session" });
    // Should NOT have created a new session
    expect(mockTrpc.session.create.mutate).not.toHaveBeenCalled();
    // Worker should be derived from the loaded session
    expect(result.current.workerId).toBe("w2");
    expect(result.current.workerName).toBe("worker-2");
    // Messages should be restored
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("msg from w2 session");
  });
});

describe("useServer hook — sendMessage", () => {
  test("adds user message optimistically and calls agent.prompt.mutate", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.sendMessage("Hello AI");
    await flushAsync();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("Hello AI");

    expect(mockTrpc.agent.prompt.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      text: "Hello AI",
    });
  });

  test("does nothing for empty text", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.sendMessage("");
    result.current.sendMessage("   ");
    await flushAsync();

    expect(result.current.messages).toHaveLength(0);
    expect(mockTrpc.agent.prompt.mutate).not.toHaveBeenCalled();
  });

  test("sets error when no session established", async () => {
    // Make init fail so no session is created
    mockTrpc.agent.list.query.mockImplementation(async () => ({ workers: [] }));

    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.error).not.toBeNull());

    // Clear the error from init failure, then try sending
    result.current.sendMessage("test");
    await flushAsync();

    // Error should mention no session
    expect(result.current.error).not.toBeNull();
  });
});

describe("useServer hook — abort", () => {
  test("calls agent.abort.mutate with correct sessionId", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.abort();
    await flushAsync();

    expect(mockTrpc.agent.abort.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
    });
  });
});

describe("useServer hook — reset", () => {
  test("clears messages/status/error, preserves connected/sessionId", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    // Add a message first
    result.current.sendMessage("hello");
    await flushAsync();
    expect(result.current.messages).toHaveLength(1);

    result.current.reset();
    await flushAsync();

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.streamingContent).toBe("");
    expect(result.current.connected).toBe(true);
    expect(result.current.sessionId).toBe("new-session-1");
  });
});

describe("useServer hook — approveToolCall", () => {
  test("calls tool.approve.mutate and removes from pendingApprovals", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));
    await waitFor(() => expect(onDataCallback).not.toBeNull());

    // Simulate a tool approval event
    onDataCallback!({
      type: "tool_approval_required",
      toolCallId: "tc1",
      toolName: "dangerous_tool",
      arguments: "{}",
      sessionId: "new-session-1",
    });
    await flushAsync();

    expect(result.current.pendingApprovals).toHaveLength(1);

    result.current.approveToolCall("tc1");
    await flushAsync();

    expect(mockTrpc.tool.approve.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      toolCallId: "tc1",
    });

    await waitFor(() => {
      expect(result.current.pendingApprovals).toHaveLength(0);
    });
  });
});

describe("useServer hook — denyToolCall", () => {
  test("calls tool.deny.mutate and removes from pendingApprovals", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));
    await waitFor(() => expect(onDataCallback).not.toBeNull());

    // Simulate a tool approval event
    onDataCallback!({
      type: "tool_approval_required",
      toolCallId: "tc2",
      toolName: "risky_tool",
      arguments: "{}",
      sessionId: "new-session-1",
    });
    await flushAsync();

    expect(result.current.pendingApprovals).toHaveLength(1);

    result.current.denyToolCall("tc2");
    await flushAsync();

    expect(mockTrpc.tool.deny.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      toolCallId: "tc2",
    });

    await waitFor(() => {
      expect(result.current.pendingApprovals).toHaveLength(0);
    });
  });
});

describe("useServer hook — addSystemMessage", () => {
  test("appends system message to state", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.addSystemMessage("Worker connected");
    await flushAsync();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("system");
    expect(result.current.messages[0].content).toBe("Worker connected");
  });
});

describe("useServer hook — listSessions", () => {
  test("returns sessions from session.list.query", async () => {
    const sessionList = [
      { sessionId: "s1", name: "Session 1", workerId: "w1", createdAt: 1000, lastActiveAt: 2000, messageCount: 5, active: true },
      { sessionId: "s2", name: "Session 2", workerId: "w1", createdAt: 1500, lastActiveAt: 2500, messageCount: 3, active: false },
    ];
    mockTrpc.session.list.query.mockImplementation(async () => ({ sessions: sessionList, total: sessionList.length }));

    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    const sessions = await result.current.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[1].name).toBe("Session 2");
  });
});

describe("useServer hook — switchSession", () => {
  test("loads session, resets state, resubscribes to events", async () => {
    const switchMessages = [
      { id: "m10", role: "user", content: "switched msg", timestamp: 5000 },
    ];
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "Switched",
      workerId: "w1",
      messages: switchMessages,
    }));

    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    // Add a message to the initial session
    result.current.sendMessage("original message");
    await flushAsync();
    expect(result.current.messages).toHaveLength(1);

    const initialSubscribeCalls = mockTrpc.agent.onEvents.subscribe.mock.calls.length;

    await result.current.switchSession("other-session");
    await flushAsync();

    expect(mockTrpc.session.load.mutate).toHaveBeenCalledWith({ sessionId: "other-session" });
    // Should have resubscribed
    expect(mockTrpc.agent.onEvents.subscribe.mock.calls.length).toBeGreaterThan(initialSubscribeCalls);
    // Messages should be from the switched session
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("switched msg");
    expect(result.current.sessionId).toBe("other-session");
  });
});

describe("useServer hook — newSession", () => {
  test("creates session, resets state, resubscribes", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    // Add a message to current session
    result.current.sendMessage("old message");
    await flushAsync();
    expect(result.current.messages).toHaveLength(1);

    // Create a fresh session ID
    mockTrpc.session.create.mutate.mockImplementation(async () => ({
      sessionId: "brand-new-session",
      name: "New",
      workerId: "w1",
      createdAt: Date.now(),
    }));

    const initialSubscribeCalls = mockTrpc.agent.onEvents.subscribe.mock.calls.length;

    await result.current.newSession();
    await flushAsync();

    expect(mockTrpc.session.create.mutate).toHaveBeenCalled();
    expect(result.current.sessionId).toBe("brand-new-session");
    expect(result.current.messages).toHaveLength(0);
    // Should have resubscribed
    expect(mockTrpc.agent.onEvents.subscribe.mock.calls.length).toBeGreaterThan(initialSubscribeCalls);
  });
});

describe("useServer hook — renameSession", () => {
  test("calls session.rename.mutate with correct args", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    await result.current.renameSession("My Cool Session");

    expect(mockTrpc.session.rename.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      name: "My Cool Session",
    });
  });
});

describe("useServer hook — event subscription", () => {
  test("events pushed via onData update hook state", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));
    await waitFor(() => expect(onDataCallback).not.toBeNull());

    // Push a status_change event
    onDataCallback!({ type: "status_change", status: "streaming" });
    await flushAsync();
    expect(result.current.status).toBe("streaming");

    // Push a content_delta event
    onDataCallback!({ type: "content_delta", delta: "Hi", content: "Hi there" });
    await flushAsync();
    expect(result.current.streamingContent).toBe("Hi there");

    // Push a tool_call_start event
    onDataCallback!({
      type: "tool_call_start",
      toolCallId: "tc1",
      toolName: "read_file",
      arguments: '{"path":"/foo"}',
    });
    await flushAsync();
    expect(result.current.activeToolCalls).toHaveLength(1);
    expect(result.current.activeToolCalls[0].toolName).toBe("read_file");

    // Push a tool_call_end event
    onDataCallback!({
      type: "tool_call_end",
      toolCallId: "tc1",
      toolName: "read_file",
      result: "file contents",
    });
    await flushAsync();
    expect(result.current.activeToolCalls[0].result).toBe("file contents");

    // Push a turn_complete event
    onDataCallback!({
      type: "turn_complete",
      message: {
        id: "m1",
        role: "assistant",
        content: "Here is the file",
        timestamp: Date.now(),
      },
    });
    await flushAsync();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("Here is the file");
    expect(result.current.streamingContent).toBe("");
    expect(result.current.activeToolCalls).toHaveLength(0);
    expect(result.current.completedToolCalls).toHaveLength(1);
  });

  test("error event from subscription sets error on state", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));
    await waitFor(() => expect(onErrorCallback).not.toBeNull());

    onErrorCallback!(new Error("subscription broken"));
    await flushAsync();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("subscription broken");
  });
});

describe("useServer hook — cleanup", () => {
  test("unmount closes WebSocket and unsubscribes", async () => {
    const { result, unmount } = renderUseServer();
    cleanup = null; // We handle unmount manually here

    await waitFor(() => expect(result.current.connected).toBe(true));
    await waitFor(() => expect(onDataCallback).not.toBeNull());

    unmount();
    await flushAsync();

    expect(subscriptionUnsubscribe).toHaveBeenCalled();
    expect(mockWsClient.close).toHaveBeenCalled();
  });
});

describe("useServer hook — sendMessage error handling", () => {
  test("sets error when agent.prompt.mutate rejects", async () => {
    mockTrpc.agent.prompt.mutate.mockImplementation(async () => {
      throw new Error("LLM quota exceeded");
    });

    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.sendMessage("cause error");
    await flushAsync(100);

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error!.message).toBe("LLM quota exceeded");
  });
});

describe("useServer hook — newSession worker discovery", () => {
  test("reuses workerIdRef from loaded session for newSession", async () => {
    // Init via sessionId — workerIdRef is set to loaded session's workerId
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "Loaded",
      workerId: "w1",
      messages: [],
    }));

    const { result } = renderUseServer({ sessionId: "existing-session" });

    await waitFor(() => expect(result.current.connected).toBe(true));

    mockTrpc.session.create.mutate.mockImplementation(async () => ({
      sessionId: "discovered-session",
      name: "New",
      workerId: "w1",
      createdAt: Date.now(),
    }));

    await result.current.newSession();
    await flushAsync();

    // workerIdRef was already set from loaded session, so newSession reuses it
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1" });
    expect(result.current.sessionId).toBe("discovered-session");
    expect(result.current.messages).toHaveLength(0);
  });

  test("sets error when no workers available and workerIdRef is null", async () => {
    // Make init fail to set workerIdRef by returning no workers
    mockTrpc.agent.list.query.mockImplementation(async () => ({ workers: [] }));

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    // Init already set error — newSession also discovers empty
    await result.current.newSession();
    await flushAsync();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("No workers connected");
  });
});
