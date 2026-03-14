import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
import type { AgentEvent } from "@molf-ai/protocol";

// ---------------------------------------------------------------------------
// Mock state — declared in vi.hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const { state, createMockClient, createMockAsyncIterable, DEFAULT_WORKSPACE } = vi.hoisted(() => {
  function createMockAsyncIterable() {
    const queue: any[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const iterable = {
      [Symbol.asyncIterator]() { return iterable; },
      async next() {
        while (queue.length === 0 && !done) {
          await new Promise<void>(r => { resolve = r; });
        }
        if (queue.length > 0) return { value: queue.shift(), done: false };
        return { value: undefined, done: true };
      },
      async return() { done = true; return { value: undefined, done: true }; },
    };

    return {
      iterable,
      push(value: any) { queue.push(value); if (resolve) { resolve(); resolve = null; } },
      end() { done = true; if (resolve) { resolve(); resolve = null; } },
    };
  }

  const state = {
    eventIteratorController: null as { push: (event: any) => void; end: () => void } | null,
    eventIterator: null as any,
    workspaceEventIterator: null as any,
    shellExecMock: vi.fn(async (_input: any) => ({
      output: "file.txt\n",
      exitCode: 0,
      truncated: false,
    })),
    mockClient: null as any,
    mockWs: {
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };

  const DEFAULT_WORKSPACE = {
    id: "ws-default",
    name: "main",
    isDefault: true,
    lastSessionId: "new-session-1",
    sessions: ["new-session-1"],
    createdAt: 1000,
    config: {},
  };

  function createMockClient() {
    return {
      session: {
        create: vi.fn(async (_input: any) => ({ sessionId: "new-session-1", name: "Session", workerId: "w1", createdAt: Date.now() })),
        load: vi.fn(async (_input: any) => ({ sessionId: _input.sessionId, name: "Loaded", workerId: "w1", messages: [] })),
        list: vi.fn(async () => ({ sessions: [], total: 0 })),
        rename: vi.fn(async (_input: any) => ({ renamed: true })),
        delete: vi.fn(async (_input: any) => ({ deleted: true })),
      },
      agent: {
        list: vi.fn(async () => ({ workers: [{ workerId: "w1", name: "worker-1", tools: [], skills: [], connected: true }] })),
        prompt: vi.fn(async (_input: any) => ({ messageId: "msg-1" })),
        abort: vi.fn(async (_input: any) => ({ aborted: true })),
        shellExec: state.shellExecMock,
        onEvents: vi.fn(async (_input: any) => state.eventIterator),
      },
      tool: {
        approve: vi.fn(async (_input: any) => ({ applied: true })),
        deny: vi.fn(async (_input: any) => ({ applied: true })),
      },
      workspace: {
        ensureDefault: vi.fn(async (_input: any) => ({ workspace: { ...DEFAULT_WORKSPACE }, sessionId: DEFAULT_WORKSPACE.lastSessionId })),
        list: vi.fn(async (_input: any) => ([{ ...DEFAULT_WORKSPACE }])),
        create: vi.fn(async (_input: any) => ({ workspace: { id: "ws-new", name: _input?.name ?? "new", isDefault: false, lastSessionId: "ws-new-s1", sessions: ["ws-new-s1"], createdAt: Date.now(), config: {} }, sessionId: "ws-new-s1" })),
        rename: vi.fn(async (_input: any) => ({ success: true })),
        setConfig: vi.fn(async (_input: any) => ({ success: true })),
        sessions: vi.fn(async (_input: any) => ([])),
        onEvents: vi.fn(async (_input: any) => state.workspaceEventIterator),
      },
      auth: {
        createPairingCode: vi.fn(async (_input: any) => ({ code: "123456" })),
        listApiKeys: vi.fn(async () => []),
        revokeApiKey: vi.fn(async (_input: any) => ({ revoked: true })),
      },
      provider: {
        listModels: vi.fn(async () => ({ models: [] })),
      },
    };
  }

  const eventIter = createMockAsyncIterable();
  state.eventIteratorController = eventIter;
  state.eventIterator = eventIter.iterable;
  state.workspaceEventIterator = createMockAsyncIterable().iterable;
  state.mockClient = createMockClient();

  return { state, createMockClient, createMockAsyncIterable, DEFAULT_WORKSPACE };
});

// ---------------------------------------------------------------------------
// Mock rpc-client and protocol — MUST be before any import of use-server
// ---------------------------------------------------------------------------

vi.mock("../src/rpc-client.js", () => ({
  RPCLink: vi.fn(() => "mock-link"),
  createORPCClient: vi.fn(() => state.mockClient),
}));

vi.mock("@molf-ai/protocol", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAuthWebSocket: vi.fn(() => {
      return vi.fn(() => state.mockWs);
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the module under test (vi.mock is hoisted above this)
// ---------------------------------------------------------------------------

import { useServer } from "../src/hooks/use-server.js";
import { createResetState, createInitialState } from "../src/hooks/event-reducer.js";

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
  { timeout = 3000 } = {},
) {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await flushAsync();
    }
  }
}

import { flushAsync } from "@molf-ai/test-utils";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let cleanup: (() => void) | null = null;

beforeEach(() => {
  state.shellExecMock = vi.fn(async (_input: any) => ({
    output: "file.txt\n",
    exitCode: 0,
    truncated: false,
  }));
  const eventIter = createMockAsyncIterable();
  state.eventIteratorController = eventIter;
  state.eventIterator = eventIter.iterable;
  state.workspaceEventIterator = createMockAsyncIterable().iterable;
  state.mockClient = createMockClient();
  state.mockWs = {
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
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
    state.shellExecMock = vi.fn(() => deferred);
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => ({
      output: "hello world",
      exitCode: 0,
      truncated: false,
    }));
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => ({
      output: "lots of output...",
      exitCode: 0,
      truncated: true,
    }));
    state.mockClient = createMockClient();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("find /");
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("[output truncated]");
  });

  test("success with empty output", async () => {
    state.shellExecMock = vi.fn(async () => ({
      output: "",
      exitCode: 0,
      truncated: false,
    }));
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => { throw precondErr; });
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => { throw timeoutErr; });
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => { throw new Error("Something went wrong"); });
    state.mockClient = createMockClient();

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
    state.mockClient.agent.list.mockImplementation(async () => ({ workers: [] }));

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.error).not.toBeNull());

    result.current.executeShell("ls");
    await flushAsync();

    const sysMessages = result.current.messages.filter((m) => m.role === "system");
    expect(sysMessages).toHaveLength(1);
    expect(sysMessages[0].content).toBe("No worker connected");
  });

  test("calls agent.shellExec with correct sessionId and command", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("echo hello");
    await flushAsync(100);

    expect(state.mockClient.agent.shellExec).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "echo hello",
      saveToSession: undefined,
    });
  });

  test("passes saveToSession=true to call when specified", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", true);
    await flushAsync(100);

    expect(state.mockClient.agent.shellExec).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "ls",
      saveToSession: true,
    });
  });

  test("passes saveToSession=false to call when specified", async () => {
    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", false);
    await flushAsync(100);

    expect(state.mockClient.agent.shellExec).toHaveBeenCalledWith({
      sessionId: "new-session-1",
      command: "ls",
      saveToSession: false,
    });
  });

  test("shows [saved to context] indicator when saveToSession=true", async () => {
    state.shellExecMock = vi.fn(async () => ({
      output: "file.txt",
      exitCode: 0,
      truncated: false,
    }));
    state.mockClient = createMockClient();

    const { result } = renderUseServer();
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.executeShell("ls", true);
    await flushAsync(100);

    await waitFor(() => expect(result.current.isShellRunning).toBe(false));

    const content = result.current.messages.filter((m) => m.role === "system")[0].content;
    expect(content).toContain("[saved to context]");
  });

  test("does not show [saved to context] when saveToSession=false", async () => {
    state.shellExecMock = vi.fn(async () => ({
      output: "file.txt",
      exitCode: 0,
      truncated: false,
    }));
    state.mockClient = createMockClient();

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
    state.shellExecMock = vi.fn(async () => { throw conflictErr; });
    state.mockClient = createMockClient();

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
    const resetState = createResetState(true, "s1");
    expect(resetState.isShellRunning).toBe(false);
  });

  test("isShellRunning is false in createInitialState", async () => {
    const initialState = createInitialState({});
    expect(initialState.isShellRunning).toBe(false);
  });
});
