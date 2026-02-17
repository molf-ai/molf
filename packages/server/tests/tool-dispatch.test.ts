import { describe, test, expect } from "bun:test";
import { ToolDispatch } from "../src/tool-dispatch.js";

describe("ToolDispatch", () => {
  test("dispatch + resolveToolCall flow", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", "hello");
    const result = await promise;
    expect(result.result).toBe("hello");
  });

  test("subscribeWorker yields queued requests", async () => {
    const td = new ToolDispatch();
    // Dispatch before subscribing
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });

    const ac = new AbortController();
    const items: any[] = [];
    const gen = td.subscribeWorker("w1", ac.signal);

    // Get first item (queued)
    const { value, done } = await gen.next();
    items.push(value);
    expect(items[0].toolCallId).toBe("tc1");

    // Resolve and clean up
    td.resolveToolCall("tc1", "ok");
    ac.abort();
    await promise;
  });

  test("subscribeWorker yields live requests", async () => {
    const td = new ToolDispatch();
    const ac = new AbortController();
    const gen = td.subscribeWorker("w1", ac.signal);

    // Dispatch after subscribing
    const promise = td.dispatch("w1", { toolCallId: "tc2", toolName: "shell", args: {} });

    const { value } = await gen.next();
    expect(value!.toolCallId).toBe("tc2");

    td.resolveToolCall("tc2", "done");
    ac.abort();
    await promise;
  });

  test("resolveToolCall unknown toolCallId", () => {
    const td = new ToolDispatch();
    expect(td.resolveToolCall("unknown", "value")).toBe(false);
  });

  test("workerDisconnected resolves pending with error", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.workerDisconnected("w1");
    const result = await promise;
    expect(result.error).toContain("disconnected");
  });

  test("workerDisconnected cleans up queues", () => {
    const td = new ToolDispatch();
    td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.workerDisconnected("w1");
    // No error — clean up is silent
  });

  test("multiple concurrent dispatches to same worker", async () => {
    const td = new ToolDispatch();
    const p1 = td.dispatch("w1", { toolCallId: "tc1", toolName: "a", args: {} });
    const p2 = td.dispatch("w1", { toolCallId: "tc2", toolName: "b", args: {} });
    td.resolveToolCall("tc1", "r1");
    td.resolveToolCall("tc2", "r2");
    expect((await p1).result).toBe("r1");
    expect((await p2).result).toBe("r2");
  });

  test("dispatch to worker not yet subscribed (queuing)", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });

    // Subscribe later
    const ac = new AbortController();
    const gen = td.subscribeWorker("w1", ac.signal);
    const { value } = await gen.next();
    expect(value!.toolCallId).toBe("tc1");

    td.resolveToolCall("tc1", "ok");
    ac.abort();
    await promise;
  });

  test("abort signal stops subscribeWorker", async () => {
    const td = new ToolDispatch();
    const ac = new AbortController();
    const gen = td.subscribeWorker("w1", ac.signal);
    ac.abort();
    const { done } = await gen.next();
    expect(done).toBe(true);
  });

  test("abort signal fires onAbort while waiting in subscribeWorker", async () => {
    const td = new ToolDispatch();
    const ac = new AbortController();
    const gen = td.subscribeWorker("w1", ac.signal);

    // Start the generator — it enters the while loop and waits in the Promise
    const nextPromise = gen.next();
    await Bun.sleep(10);

    // Abort while the generator is waiting for a request
    ac.abort();
    const { done } = await nextPromise;
    expect(done).toBe(true);
  });

  test("resolveToolCall with error string", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", null, "tool failed");
    const result = await promise;
    expect(result.error).toBe("tool failed");
  });

  // --- JsonValue | null result type tests ---

  test("resolveToolCall with null result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", null);
    const result = await promise;
    expect(result.result).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("resolveToolCall with string result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", "plain text output");
    const result = await promise;
    expect(result.result).toBe("plain text output");
  });

  test("resolveToolCall with nested object result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { files: [{ name: "a.txt" }], count: 1 });
    const result = await promise;
    expect(result.result).toEqual({ files: [{ name: "a.txt" }], count: 1 });
  });

  test("resolveToolCall with array result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", [1, "two", null, true]);
    const result = await promise;
    expect(result.result).toEqual([1, "two", null, true]);
  });

  test("resolveToolCall with number result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", 42);
    const result = await promise;
    expect(result.result).toBe(42);
  });

  test("resolveToolCall with boolean result", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", false);
    const result = await promise;
    expect(result.result).toBe(false);
  });

  // --- Dispatch timeout behavior (Step 5) ---
  // Note: ToolDispatch uses default 120s timeout from WorkerDispatch.
  // Timeout with custom durations is tested directly in worker-dispatch.test.ts.

  test("dispatch resolves successfully before default timeout", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    // Resolve immediately — should succeed without hitting default timeout
    td.resolveToolCall("tc1", "fast");
    const result = await promise;
    expect(result.result).toBe("fast");
  });
});
