import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AgentEvent } from "@molf-ai/protocol";

// ---------------------------------------------------------------------------
// Mock state — declared before mock.module so closures capture these refs
// ---------------------------------------------------------------------------

let onDataCallback: ((event: AgentEvent) => void) | null = null;
let onErrorCallback: ((err: unknown) => void) | null = null;
let subscriptionUnsubscribe = mock(() => {});

let shellExecMock = mock(async (_input: any) => ({
  output: "file.txt\n",
  exitCode: 0,
  truncated: false,
}));

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
      shellExec: { mutate: shellExecMock },
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

async function flushAsync(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let cleanup: (() => void) | null = null;

beforeEach(() => {
  shellExecMock = mock(async (_input: any) => ({
    output: "file.txt\n",
    exitCode: 0,
    truncated: false,
  }));
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
// Tests — executeShell
// ---------------------------------------------------------------------------

describe("useServer hook — executeShell", () => {
  test("sets isShellRunning true during the call, false after success", async () => {
    // Use a deferred promise so we can observe isShellRunning=true
    let resolve!: (value: any) => void;
    const deferred = new Promise<any>((r) => { resolve = r; });
    shellExecMock = mock(() => deferred);
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    expect(result.current.isShellRunning).toBe(false);

    result.current.executeShell("ls");
    await flushAsync();

    // Should be running
    expect(result.current.isShellRunning).toBe(true);

    // Resolve the promise
    resolve({ output: "file.txt", exitCode: 0, truncated: false });
    await flushAsync(100);

    // Should be done
    await waitFor(() => {
      expect(result.current.isShellRunning).toBe(false);
    });
  });

  test("success appends system message with correctly formatted result text", async () => {
    shellExecMock = mock(async () => ({
      output: "hello world",
      exitCode: 0,
      truncated: false,
    }));
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("echo hello world");
    await flushAsync(100);

    await waitFor(() => {
      expect(result.current.isShellRunning).toBe(false);
    });

    // Should have exactly one system message
    const sysMessages = result.current.messages.filter((m) => m.role === "system");
    expect(sysMessages).toHaveLength(1);

    const content = sysMessages[0].content;
    expect(content).toContain("$ echo hello world");
    expect(content).toContain("hello world");
    expect(content).toContain("Exit 0");
    expect(content).not.toContain("[output truncated]");
  });

  test("success with truncated output shows truncation marker", async () => {
    shellExecMock = mock(async () => ({
      output: "lots of output...",
      exitCode: 0,
      truncated: true,
    }));
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("find /");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("[output truncated]");
  });

  test("success with empty output", async () => {
    shellExecMock = mock(async () => ({
      output: "",
      exitCode: 0,
      truncated: false,
    }));
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("true");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    // Should be just "$ true\n\nExit 0"
    expect(content).toBe("$ true\n\nExit 0");
  });

  test("error PRECONDITION_FAILED appends system message with worker not connected text", async () => {
    const precondErr = Object.assign(new Error("PRECONDITION_FAILED"), {
      data: { code: "PRECONDITION_FAILED" },
    });
    shellExecMock = mock(async () => { throw precondErr; });
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const sysMessages = result.current.messages.filter((m) => m.role === "system");
    expect(sysMessages).toHaveLength(1);

    const content = sysMessages[0].content;
    expect(content).toContain("$ ls");
    expect(content).toContain("No worker connected. Shell commands require an active worker.");
  });

  test("error with timeout message shows timeout text", async () => {
    const timeoutErr = new Error("Operation timeout after 120000ms");
    shellExecMock = mock(async () => { throw timeoutErr; });
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("sleep 999");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("$ sleep 999");
    expect(content).toContain("Shell execution failed: timed out after 120s");
  });

  test("error with generic error shows error message", async () => {
    shellExecMock = mock(async () => { throw new Error("Something went wrong"); });
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("bad-cmd");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("$ bad-cmd");
    expect(content).toContain("Shell execution failed: Something went wrong");
  });

  test("executeShell with no connection adds system message", async () => {
    // Make init fail so no trpc/session
    mockTrpc.agent.list.query.mockImplementation(async () => ({ workers: [] }));

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.error).not.toBeNull());

    result.current.executeShell("ls");
    await flushAsync();

    const sysMessages = result.current.messages.filter((m) => m.role === "system");
    expect(sysMessages).toHaveLength(1);
    expect(sysMessages[0].content).toBe("No worker connected");
  });

  test("calls agent.shellExec.mutate with correct sessionId and command", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("echo hello");
    await flushAsync(100);

    expect(mockTrpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "echo hello",
      saveToSession: undefined,
    });
  });

  test("passes saveToSession=true to mutate when specified", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", true);
    await flushAsync(100);

    expect(mockTrpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "ls",
      saveToSession: true,
    });
  });

  test("passes saveToSession=false to mutate when specified", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", false);
    await flushAsync(100);

    expect(mockTrpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "ls",
      saveToSession: false,
    });
  });

  test("shows [saved to context] indicator when saveToSession=true", async () => {
    shellExecMock = mock(async () => ({
      output: "file.txt",
      exitCode: 0,
      truncated: false,
    }));
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", true);
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("[saved to context]");
  });

  test("does not show [saved to context] when saveToSession=false", async () => {
    shellExecMock = mock(async () => ({
      output: "file.txt",
      exitCode: 0,
      truncated: false,
    }));
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", false);
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).not.toContain("[saved to context]");
  });

  test("error CONFLICT shows agent busy message", async () => {
    const conflictErr = Object.assign(new Error("CONFLICT"), {
      data: { code: "CONFLICT" },
    });
    shellExecMock = mock(async () => { throw conflictErr; });
    mockTrpc = createMockTrpc();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", true);
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const sysMessages = result.current.messages.filter((m) => m.role === "system");
    expect(sysMessages).toHaveLength(1);

    const content = sysMessages[0].content;
    expect(content).toContain("$ ls");
    expect(content).toContain("Agent is busy");
    expect(content).toContain("!!");
  });
});

// ---------------------------------------------------------------------------
// Tests — isShellRunning in state
// ---------------------------------------------------------------------------

describe("isShellRunning state", () => {
  test("initial state has isShellRunning=false", async () => {
    const { result } = renderUseServer();
    expect(result.current.isShellRunning).toBe(false);
  });

  test("isShellRunning resets to false on createResetState", async () => {
    const { createResetState } = await import("../src/hooks/event-reducer.js");
    const state = createResetState(true, "s1");
    expect(state.isShellRunning).toBe(false);
  });

  test("isShellRunning is false in createInitialState", async () => {
    const { createInitialState } = await import("../src/hooks/event-reducer.js");
    const state = createInitialState({});
    expect(state.isShellRunning).toBe(false);
  });
});
