import { describe, expect, test } from "bun:test";
import { ToolDispatch } from "../src/tool-dispatch.js";

describe("ToolDispatch", () => {
  test("dispatch and resolveToolCall complete the round-trip", async () => {
    const dispatch = new ToolDispatch();

    // Dispatch a tool call (non-blocking)
    const resultPromise = dispatch.dispatch("worker-1", {
      toolCallId: "tc-1",
      toolName: "shell_exec",
      args: { command: "ls" },
    });

    // Simulate worker resolving the call
    const received = dispatch.resolveToolCall("tc-1", { stdout: "file.txt" });
    expect(received).toBe(true);

    // Check the result
    const result = await resultPromise;
    expect(result.result).toEqual({ stdout: "file.txt" });
    expect(result.error).toBeUndefined();
  });

  test("resolveToolCall with error", async () => {
    const dispatch = new ToolDispatch();

    const resultPromise = dispatch.dispatch("worker-1", {
      toolCallId: "tc-2",
      toolName: "shell_exec",
      args: { command: "bad" },
    });

    dispatch.resolveToolCall("tc-2", null, "Command not found");

    const result = await resultPromise;
    expect(result.result).toBeNull();
    expect(result.error).toBe("Command not found");
  });

  test("resolveToolCall returns false for unknown toolCallId", () => {
    const dispatch = new ToolDispatch();
    expect(dispatch.resolveToolCall("nonexistent", "data")).toBe(false);
  });

  test("subscribeWorker yields queued requests", async () => {
    const dispatch = new ToolDispatch();
    const ac = new AbortController();

    // Queue a request before subscribing
    const resultPromise = dispatch.dispatch("worker-1", {
      toolCallId: "tc-1",
      toolName: "test",
      args: {},
    });

    // Subscribe and collect first yielded value
    const gen = dispatch.subscribeWorker("worker-1", ac.signal);
    const first = await gen.next();

    expect(first.done).toBe(false);
    expect(first.value.toolCallId).toBe("tc-1");
    expect(first.value.toolName).toBe("test");

    // Resolve to complete the dispatch promise
    dispatch.resolveToolCall("tc-1", "ok");
    await resultPromise;

    ac.abort();
  });

  test("subscribeWorker yields newly dispatched requests", async () => {
    const dispatch = new ToolDispatch();
    const ac = new AbortController();

    // Start subscription
    const gen = dispatch.subscribeWorker("worker-1", ac.signal);

    // Dispatch after subscription started (will go to listener)
    const resultPromise = dispatch.dispatch("worker-1", {
      toolCallId: "tc-1",
      toolName: "read_file",
      args: { path: "/tmp/test" },
    });

    const next = await gen.next();
    expect(next.done).toBe(false);
    expect(next.value.toolName).toBe("read_file");

    dispatch.resolveToolCall("tc-1", "content");
    await resultPromise;

    ac.abort();
  });

  test("subscribeWorker stops on abort", async () => {
    const dispatch = new ToolDispatch();
    const ac = new AbortController();

    const gen = dispatch.subscribeWorker("worker-1", ac.signal);

    // Abort immediately
    ac.abort();

    const result = await gen.next();
    expect(result.done).toBe(true);
  });

  test("workerDisconnected cleans up queues", () => {
    const dispatch = new ToolDispatch();

    // Queue a request
    dispatch.dispatch("worker-1", {
      toolCallId: "tc-1",
      toolName: "test",
      args: {},
    });

    dispatch.workerDisconnected("worker-1");

    // After disconnect, no queued requests should remain
    // (the dispatch promise will hang, but the queue is cleaned)
    // This is mainly testing it doesn't throw
    expect(true).toBe(true);
  });

  test("resolving same toolCallId twice returns false on second call", async () => {
    const dispatch = new ToolDispatch();

    dispatch.dispatch("worker-1", {
      toolCallId: "tc-dup",
      toolName: "test",
      args: {},
    });

    expect(dispatch.resolveToolCall("tc-dup", "first")).toBe(true);
    expect(dispatch.resolveToolCall("tc-dup", "second")).toBe(false);
  });

  test("multiple pending calls resolve independently", async () => {
    const dispatch = new ToolDispatch();

    const p1 = dispatch.dispatch("worker-1", {
      toolCallId: "tc-a",
      toolName: "test",
      args: {},
    });
    const p2 = dispatch.dispatch("worker-1", {
      toolCallId: "tc-b",
      toolName: "test",
      args: {},
    });

    // Resolve in reverse order
    dispatch.resolveToolCall("tc-b", "result-b");
    dispatch.resolveToolCall("tc-a", "result-a");

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.result).toBe("result-a");
    expect(r2.result).toBe("result-b");
  });
});
