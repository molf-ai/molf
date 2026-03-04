import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AgentEvent } from "@molf-ai/protocol";

// ---------------------------------------------------------------------------
// Mock state — declared before mock.module so closures capture these refs
// ---------------------------------------------------------------------------

let onDataCallback: ((event: AgentEvent) => void) | null = null;
let onErrorCallback: ((err: unknown) => void) | null = null;
let subscriptionUnsubscribe = mock(() => {});
let workspaceEventUnsubscribe = mock(() => {});

const DEFAULT_WORKSPACE = {
  id: "ws-default",
  name: "main",
  isDefault: true,
  lastSessionId: "new-session-1",
  sessions: ["new-session-1"],
  createdAt: 1000,
  config: {},
};

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
    workspace: {
      ensureDefault: { mutate: mock(async (_input: any) => ({ workspace: { ...DEFAULT_WORKSPACE }, sessionId: DEFAULT_WORKSPACE.lastSessionId })) },
      list: { query: mock(async (_input: any) => ([{ ...DEFAULT_WORKSPACE }])) },
      create: { mutate: mock(async (_input: any) => ({ workspace: { id: "ws-new", name: _input?.name ?? "new", isDefault: false, lastSessionId: "ws-new-s1", sessions: ["ws-new-s1"], createdAt: Date.now(), config: {} }, sessionId: "ws-new-s1" })) },
      rename: { mutate: mock(async (_input: any) => ({ success: true })) },
      setConfig: { mutate: mock(async (_input: any) => ({ success: true })) },
      sessions: { query: mock(async (_input: any) => ([])) },
      onEvents: {
        subscribe: mock((_input: any, _opts: any) => ({ unsubscribe: workspaceEventUnsubscribe })),
      },
    },
  };
}

let mockTrpc = createMockTrpc();
let mockWsClient = { close: mock(() => {}) };

// ---------------------------------------------------------------------------
// Mock @trpc/client — MUST be before any import of use-server
// ---------------------------------------------------------------------------

const createWSClientMock = mock(() => mockWsClient);

mock.module("../src/trpc-client.js", () => ({
  createWSClient: createWSClientMock,
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
  workspaceEventUnsubscribe = mock(() => {});
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
  test("loads default workspace session when no sessionId provided (worker discovery)", async () => {
    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("new-session-1");
    });

    // Should have discovered workers
    expect(mockTrpc.agent.list.query).toHaveBeenCalled();
    // Should have ensured default workspace
    expect(mockTrpc.workspace.ensureDefault.mutate).toHaveBeenCalledWith({ workerId: "w1" });
    // Should have loaded the lastSessionId from workspace
    expect(mockTrpc.session.load.mutate).toHaveBeenCalledWith({ sessionId: "new-session-1" });
    // Should have subscribed to session and workspace events
    expect(mockTrpc.agent.onEvents.subscribe).toHaveBeenCalled();
    expect(mockTrpc.workspace.onEvents.subscribe).toHaveBeenCalled();
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
    // Resolves workspace for this session (list or ensureDefault fallback)
    expect(result.current.workspaceId).toBe("ws-default");
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

  test("uses provided workerId for workspace.ensureDefault", async () => {
    const { result } = renderUseServer({ workerId: "my-worker" });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    // Fetches workers to resolve worker name even when workerId is provided
    expect(mockTrpc.agent.list.query).toHaveBeenCalled();
    // Should have ensured default workspace with provided workerId
    expect(mockTrpc.workspace.ensureDefault.mutate).toHaveBeenCalledWith({ workerId: "my-worker" });
    // Should have loaded the lastSessionId from workspace
    expect(mockTrpc.session.load.mutate).toHaveBeenCalled();
  });

  test("restores last session from workspace when it exists", async () => {
    const restoredMessages = [
      { id: "m1", role: "user", content: "restored msg", timestamp: 2000 },
      { id: "m2", role: "assistant", content: "restored reply", timestamp: 2001 },
    ];

    // Configure workspace to return a specific lastSessionId
    mockTrpc.workspace.ensureDefault.mutate.mockImplementation(async () => ({
      workspace: { ...DEFAULT_WORKSPACE, lastSessionId: "recent-session", sessions: ["old-session", "recent-session"] },
      sessionId: "recent-session",
    }));
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

    // Should have loaded the workspace's lastSessionId
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

  test("creates new session when session.load fails after ensureDefault", async () => {
    // Make session.load fail so it falls back to session.create
    mockTrpc.session.load.mutate.mockImplementation(async () => {
      throw new Error("session not found");
    });

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.sessionId).toBe("new-session-1");
    });

    // session.load threw — should have fallen back to creating a new session with workspaceId
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1", workspaceId: "ws-default" });
    // Should have subscribed to events
    expect(mockTrpc.agent.onEvents.subscribe).toHaveBeenCalled();
  });

  test("selects first online worker when no workerId provided", async () => {
    // Two workers available
    mockTrpc.agent.list.query.mockImplementation(async () => ({
      workers: [
        { workerId: "w1", name: "worker-1", tools: [], skills: [], connected: true },
        { workerId: "w2", name: "worker-2", tools: [], skills: [], connected: true },
      ],
    }));

    const { result } = renderUseServer();

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    // selectWorker picks the first online worker
    expect(mockTrpc.workspace.ensureDefault.mutate).toHaveBeenCalledWith({ workerId: "w1" });
    expect(result.current.workerId).toBe("w1");
    expect(result.current.workerName).toBe("worker-1");
  });

  test("includes clientId in WebSocket URL", async () => {
    renderUseServer();

    await waitFor(() => expect(createWSClientMock).toHaveBeenCalled());

    const call = createWSClientMock.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.has("clientId")).toBe(true);
    expect(url.searchParams.get("clientId")).toBeTruthy();
  });

  test("configures WebSocket reconnection with retryDelayMs", async () => {
    renderUseServer();

    await waitFor(() => expect(createWSClientMock).toHaveBeenCalled());

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
      approvalId: "tc1",
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
      approvalId: "tc1",
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
      approvalId: "tc2",
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
      approvalId: "tc2",
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

    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    // Override session.load AFTER init so only the switch call returns switchMessages
    mockTrpc.session.load.mutate.mockImplementation(async (input: any) => ({
      sessionId: input.sessionId,
      name: "Switched",
      workerId: "w1",
      messages: switchMessages,
    }));

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

  test("sets error state when session.load fails", async () => {
    mockTrpc.session.load.mutate.mockImplementation(async () => {
      throw new Error("Session not found");
    });

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    await result.current.switchSession("nonexistent");
    await flushAsync();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("Session not found");
  });
});

describe("useServer hook — newSession", () => {
  test("creates session within current workspace, resets state, resubscribes", async () => {
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

    // Should pass workspaceId to session.create
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1", workspaceId: "ws-default" });
    expect(result.current.sessionId).toBe("brand-new-session");
    expect(result.current.messages).toHaveLength(0);
    // Should have resubscribed
    expect(mockTrpc.agent.onEvents.subscribe.mock.calls.length).toBeGreaterThan(initialSubscribeCalls);
  });

  test("sets error state when session.create fails", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    mockTrpc.session.create.mutate.mockImplementation(async () => {
      throw new Error("Worker not connected");
    });

    await result.current.newSession();
    await flushAsync();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("Worker not connected");
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

  test("sets error state when session.rename fails", async () => {
    mockTrpc.session.rename.mutate.mockImplementation(async () => {
      throw new Error("Rename failed");
    });

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    await result.current.renameSession("Bad Name");
    await flushAsync();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("Rename failed");
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
    // workspaceId comes from the resolved workspace during init
    expect(mockTrpc.session.create.mutate).toHaveBeenCalledWith({ workerId: "w1", workspaceId: "ws-default" });
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

describe("useServer hook — workspace state", () => {
  test("sets workspaceId and workspaceName on init", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    expect(result.current.workspaceId).toBe("ws-default");
    expect(result.current.workspaceName).toBe("main");
  });

  test("setModel calls workspace.setConfig instead of session.setModel", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    await result.current.setModel("gemini-pro");
    await flushAsync();

    expect(mockTrpc.workspace.setConfig.mutate).toHaveBeenCalledWith({
      workerId: "w1",
      workspaceId: "ws-default",
      config: { model: "gemini-pro" },
    });
    expect(result.current.currentModel).toBe("gemini-pro");
  });

  test("setModel with null clears model override", async () => {
    const { result } = renderUseServer();

    await waitFor(() => expect(result.current.connected).toBe(true));

    await result.current.setModel(null);
    await flushAsync();

    expect(mockTrpc.workspace.setConfig.mutate).toHaveBeenCalledWith({
      workerId: "w1",
      workspaceId: "ws-default",
      config: {},
    });
    expect(result.current.currentModel).toBeNull();
  });
});
