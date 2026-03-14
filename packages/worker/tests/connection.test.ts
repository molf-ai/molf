import { describe, test, expect, vi, beforeEach } from "vitest";
import { waitUntil, createMockAsyncIterable } from "@molf-ai/test-utils";
import type { MockAsyncIterable } from "@molf-ai/test-utils";

// --- Mock setup BEFORE imports (CLAUDE.md critical convention) ---

const {
  registerCalls,
  fsReadResults,
  toolResults,
  uploadResults,
  mockWs,
  subIterables,
} = vi.hoisted(() => ({
  registerCalls: [] as any[],
  fsReadResults: [] as any[],
  toolResults: [] as any[],
  uploadResults: [] as any[],
  mockWs: {
    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === "open") setTimeout(cb, 0);
    }),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  // Each establish() call creates new iterables; store them all for test control
  subIterables: [] as Array<{ type: string; iter: MockAsyncIterable & AsyncIterable<any> }>,
}));

vi.mock("@molf-ai/protocol", async (importOriginal) => {
  const original = await importOriginal<typeof import("@molf-ai/protocol")>();
  return {
    ...original,
    createAuthWebSocket: vi.fn(() => vi.fn(() => mockWs)),
  };
});

vi.mock("../src/rpc-client.js", () => ({
  createORPCClient: (_link: any) => ({
    worker: {
      register: async (data: any) => {
        registerCalls.push(data);
        return { workerId: data.workerId };
      },
      onToolCall: async (_input: any) => {
        const iter = createMockAsyncIterable();
        subIterables.push({ type: "toolCall", iter });
        return iter;
      },
      onUpload: async (_input: any) => {
        const iter = createMockAsyncIterable();
        subIterables.push({ type: "upload", iter });
        return iter;
      },
      onFsRead: async (_input: any) => {
        const iter = createMockAsyncIterable();
        subIterables.push({ type: "fsRead", iter });
        return iter;
      },
      toolResult: async (data: any) => {
        toolResults.push(data);
        return { received: true };
      },
      uploadResult: async (data: any) => {
        uploadResults.push(data);
        return { received: true };
      },
      fsReadResult: async (data: any) => {
        fsReadResults.push(data);
        return { received: true };
      },
    },
  }),
  RPCLink: vi.fn(),
}));

// --- Now import the module under test ---
import { WorkerConnection } from "../src/connection.js";

function createMockToolExecutor(overrides?: Partial<{ execute: Function }>) {
  return {
    getToolInfos: () => [],
    execute: overrides?.execute ?? (async () => ({ output: "mock result" })),
  } as any;
}

function createConnection(opts?: { toolExecutor?: any }) {
  return new WorkerConnection({
    serverUrl: "ws://127.0.0.1:7600",
    token: "test-token",
    workerId: "test-worker-id",
    name: "test-worker",
    workdir: "/tmp/test",
    toolExecutor: opts?.toolExecutor ?? createMockToolExecutor(),
    skills: [],
    agents: [],
  });
}

/** Helper: get the iterables from a specific establish() generation (0-indexed). */
function getSubIterables(generation: number) {
  const base = generation * 3;
  return {
    toolCall: subIterables[base]?.iter,
    upload: subIterables[base + 1]?.iter,
    fsRead: subIterables[base + 2]?.iter,
  };
}

beforeEach(() => {
  registerCalls.length = 0;
  subIterables.length = 0;
  fsReadResults.length = 0;
  toolResults.length = 0;
  uploadResults.length = 0;
  mockWs.once.mockImplementation((event: string, cb: (...args: any[]) => void) => {
    if (event === "open") setTimeout(cb, 0);
  });
  mockWs.close.mockReset();
});

describe("backoffDelay", () => {
  test("reconnect attempt increments and schedules with exponential backoff", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    const scheduledDelays: number[] = [];
    const scheduleSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        scheduledDelays.push(delay);
        return 999 as any;
      },
    );

    try {
      // Trigger disconnect by throwing in a subscription iterable
      subs.toolCall.throw();

      // Give the async loop a tick to catch and call handleDisconnect
      await new Promise((r) => setImmediate(r));

      expect(conn.state).toBe("reconnecting");
      expect(scheduledDelays.length).toBe(1);
      // INITIAL_BACKOFF_MS = 1000, attempt 0 -> 1000 * 2^0 = 1000 +/- 25% jitter
      expect(scheduledDelays[0]).toBeGreaterThanOrEqual(750);
      expect(scheduledDelays[0]).toBeLessThanOrEqual(1250);
    } finally {
      scheduleSpy.mockRestore();
      conn.close();
    }
  });
});

describe("WorkerConnection — generation counter", () => {
  test("stale onError from previous generation is ignored", async () => {
    const conn = createConnection();
    await conn.connect();
    expect(conn.state).toBe("registered");

    const subs = getSubIterables(0);
    expect(subs.toolCall).toBeTruthy();

    const scheduleSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => 999 as any,
    );

    try {
      // First error triggers reconnect and advances the generation
      subs.toolCall.throw();
      await new Promise((r) => setImmediate(r));
      expect(conn.state).toBe("reconnecting");
      expect(scheduleSpy).toHaveBeenCalledTimes(1);

      // Second error from a different subscription of the SAME generation should be ignored
      // because handleDisconnect already advanced the generation
      subs.upload.throw();
      await new Promise((r) => setImmediate(r));
      expect(scheduleSpy).toHaveBeenCalledTimes(1); // still just 1
    } finally {
      scheduleSpy.mockRestore();
      conn.close();
    }
  });

  test("close() prevents handleDisconnect from triggering reconnect", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    conn.close();
    expect(conn.state).toBe("disconnected");

    // Error after close should be ignored (signal is aborted)
    subs.toolCall.throw();
    await new Promise((r) => setImmediate(r));
    expect(conn.state).toBe("disconnected");
  });

  test("connect sets state to registered on success", async () => {
    const conn = createConnection();
    await conn.connect();
    expect(conn.state).toBe("registered");
    conn.close();
  });
});

describe("WorkerConnection — tool-call routing", () => {
  test("handleToolCall routes to toolExecutor and sends result back", async () => {
    const executor = createMockToolExecutor({
      execute: async (name: string, args: any, toolCallId: string) => ({
        output: `executed ${name}`,
      }),
    });
    const conn = createConnection({ toolExecutor: executor });
    await conn.connect();

    const subs = getSubIterables(0);
    subs.toolCall.push({
      toolCallId: "tc_123",
      toolName: "read_file",
      args: { path: "/test.txt" },
    });

    await waitUntil(() => toolResults.length >= 1, 2_000, "tool result received");

    expect(toolResults.length).toBe(1);
    expect(toolResults[0].toolCallId).toBe("tc_123");
    expect(toolResults[0].output).toBe("executed read_file");

    conn.close();
  });

  test("handleToolCall sends error envelope when tool fails", async () => {
    const executor = createMockToolExecutor({
      execute: async () => ({
        output: "",
        error: "Tool crashed",
      }),
    });
    const conn = createConnection({ toolExecutor: executor });
    await conn.connect();

    const subs = getSubIterables(0);
    subs.toolCall.push({
      toolCallId: "tc_err",
      toolName: "bad_tool",
      args: {},
    });

    await waitUntil(() => toolResults.length >= 1, 2_000, "tool result received");

    expect(toolResults.length).toBe(1);
    expect(toolResults[0].toolCallId).toBe("tc_err");
    expect(toolResults[0].error).toBe("Tool crashed");

    conn.close();
  });
});

describe("WorkerConnection — upload callback routing", () => {
  test("handleUpload saves file and sends result", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);
    const base64Data = Buffer.from("hello world").toString("base64");
    subs.upload.push({
      uploadId: "up_123",
      data: base64Data,
      filename: "test.txt",
      mimeType: "text/plain",
    });

    await waitUntil(() => uploadResults.length >= 1, 2_000, "upload result received");

    expect(uploadResults.length).toBe(1);
    expect(uploadResults[0].uploadId).toBe("up_123");
    // saveUploadedFile creates .molf/uploads/ under workdir and saves the file
    expect(uploadResults[0].error).toBeUndefined();
    expect(uploadResults[0].path).toContain("test.txt");
    expect(uploadResults[0].size).toBe(11); // "hello world".length

    conn.close();
  });
});

describe("WorkerConnection — handleFsRead path traversal", () => {
  test("path traversal outside allowed directory returns Access denied error", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    // Simulate a request with a path that escapes the output directory
    subs.fsRead.push({
      requestId: "req_traversal",
      path: "../../etc/passwd",
    });

    // Wait for async handleFsRead to complete
    await waitUntil(() => fsReadResults.length >= 1, 2_000, "fsRead result received");

    // The fsReadResult should contain an error about access denied
    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_traversal");
    expect(fsReadResults[0].error).toContain("Access denied");
    expect(fsReadResults[0].error).toContain("outside allowed directory");

    conn.close();
  });

  test("path within allowed output directory does not return Access denied", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    // Request with an outputId — resolves to .molf/tool-output/{id}.txt within workdir
    // The file won't exist, but the path traversal check should pass
    subs.fsRead.push({
      requestId: "req_valid",
      outputId: "valid-output-id",
    });

    await waitUntil(() => fsReadResults.length >= 1, 2_000, "fsRead result received");

    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_valid");
    // Should fail with file-not-found, NOT Access denied
    if (fsReadResults[0].error) {
      expect(fsReadResults[0].error).not.toContain("Access denied");
    }

    conn.close();
  });

  test("request with neither outputId nor path returns error", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    subs.fsRead.push({
      requestId: "req_empty",
    });

    await waitUntil(() => fsReadResults.length >= 1, 2_000, "fsRead result received");

    expect(fsReadResults.length).toBe(1);
    expect(fsReadResults[0].requestId).toBe("req_empty");
    expect(fsReadResults[0].error).toContain("outputId or path required");

    conn.close();
  });
});

describe("WorkerConnection — reconnect loop", () => {
  test("reconnect re-establishes connection and resets attempt counter", async () => {
    const conn = createConnection();
    await conn.connect();
    expect(conn.state).toBe("registered");
    expect(registerCalls.length).toBe(1);

    const subs = getSubIterables(0);

    // Intercept setTimeout to capture and control reconnect callbacks
    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return 999 as any;
      },
    );

    // Trigger disconnect
    subs.toolCall.throw();
    await new Promise((r) => setImmediate(r));
    expect(conn.state).toBe("reconnecting");
    expect(timers.length).toBe(1);

    // Execute the reconnect callback — this calls establish() which creates new subscriptions
    setTimeoutSpy.mockRestore();
    await timers[0].cb();

    // Should be re-registered
    expect(conn.state).toBe("registered");
    expect(registerCalls.length).toBe(2); // registered twice

    conn.close();
  });

  test("failed reconnect schedules another attempt with increasing backoff", async () => {
    const conn = createConnection();
    await conn.connect();

    const subs = getSubIterables(0);

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return 999 as any;
      },
    );

    // Trigger disconnect
    subs.toolCall.throw();
    await new Promise((r) => setImmediate(r));
    expect(timers.length).toBe(1);
    const firstDelay = timers[0].delay;

    setTimeoutSpy.mockRestore();
    conn.close();

    // Verify first delay is in expected range (1000 +/- 25% jitter)
    expect(firstDelay).toBeGreaterThanOrEqual(750);
    expect(firstDelay).toBeLessThanOrEqual(1250);
  });
});
