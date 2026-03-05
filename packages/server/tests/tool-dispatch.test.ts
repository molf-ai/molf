import { describe, test, expect } from "bun:test";
import { flushAsync } from "@molf-ai/test-utils";
import { ToolDispatch } from "../src/tool-dispatch.js";

describe("ToolDispatch", () => {
  test("dispatch + resolveToolCall flow", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { output: "hello" });
    const result = await promise;
    expect(result.output).toBe("hello");
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
    td.resolveToolCall("tc1", { output: "ok" });
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

    td.resolveToolCall("tc2", { output: "done" });
    ac.abort();
    await promise;
  });

  test("resolveToolCall unknown toolCallId", () => {
    const td = new ToolDispatch();
    expect(td.resolveToolCall("unknown", { output: "value" })).toBe(false);
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
    td.resolveToolCall("tc1", { output: "r1" });
    td.resolveToolCall("tc2", { output: "r2" });
    expect((await p1).output).toBe("r1");
    expect((await p2).output).toBe("r2");
  });

  test("dispatch to worker not yet subscribed (queuing)", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });

    // Subscribe later
    const ac = new AbortController();
    const gen = td.subscribeWorker("w1", ac.signal);
    const { value } = await gen.next();
    expect(value!.toolCallId).toBe("tc1");

    td.resolveToolCall("tc1", { output: "ok" });
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
    await flushAsync();

    // Abort while the generator is waiting for a request
    ac.abort();
    const { done } = await nextPromise;
    expect(done).toBe(true);
  });

  test("resolveToolCall with error string", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { output: "", error: "tool failed" });
    const result = await promise;
    expect(result.error).toBe("tool failed");
  });

  // --- ToolCallResult envelope tests ---

  test("resolveToolCall with output string", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { output: "plain text output" });
    const result = await promise;
    expect(result.output).toBe("plain text output");
    expect(result.error).toBeUndefined();
  });

  test("resolveToolCall with meta", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { output: "truncated...", meta: { truncated: true, outputId: "tc1" } });
    const result = await promise;
    expect(result.output).toBe("truncated...");
    expect(result.meta?.truncated).toBe(true);
    expect(result.meta?.outputId).toBe("tc1");
  });

  test("resolveToolCall with attachments", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "read_file", args: {} });
    td.resolveToolCall("tc1", {
      output: "[Binary file: img.png]",
      attachments: [{ mimeType: "image/png", data: "abc", path: "/img.png", size: 100 }],
    });
    const result = await promise;
    expect(result.output).toBe("[Binary file: img.png]");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("image/png");
  });

  test("resolveToolCall with instructionFiles in meta", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "read_file", args: {} });
    const files = [{ path: "pkg/AGENTS.md", content: "instructions" }];
    td.resolveToolCall("tc1", { output: "file content", meta: { instructionFiles: files } });
    const result = await promise;
    expect(result.output).toBe("file content");
    expect(result.meta?.instructionFiles).toEqual(files);
  });

  test("resolveToolCall without meta leaves field undefined", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    td.resolveToolCall("tc1", { output: "hello" });
    const result = await promise;
    expect(result.meta).toBeUndefined();
  });

  // --- Dispatch timeout behavior (Step 5) ---
  // Note: ToolDispatch uses default 120s timeout from WorkerDispatch.
  // Timeout with custom durations is tested directly in worker-dispatch.test.ts.

  test("dispatch resolves successfully before default timeout", async () => {
    const td = new ToolDispatch();
    const promise = td.dispatch("w1", { toolCallId: "tc1", toolName: "echo", args: {} });
    // Resolve immediately — should succeed without hitting default timeout
    td.resolveToolCall("tc1", { output: "fast" });
    const result = await promise;
    expect(result.output).toBe("fast");
  });
});
