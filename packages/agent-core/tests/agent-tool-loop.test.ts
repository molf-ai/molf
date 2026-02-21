import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";

const { Agent } = await import("../src/agent.js");

describe("Agent tool loop", () => {
  test("single tool call cycle", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: { text: "hi" } },
          { type: "tool-result", toolCallId: "tc1", toolName: "echo", output: "hi" },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done with tool" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("echo", {
      description: "Echo tool",
      execute: async (args: any) => args.text,
    } as any);

    const events: string[] = [];
    agent.onEvent((e) => events.push(e.type));
    const msg = await agent.prompt("Use echo");
    expect(msg.content).toBe("Done with tool");
    expect(events).toContain("tool_call_start");
    expect(events).toContain("tool_call_end");
  });

  test("multiple sequential tool calls (2 steps)", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 2) {
        return mockStreamText([
          { type: "tool-call", toolCallId: `tc${callCount}`, toolName: "echo", input: { text: `call${callCount}` } },
          { type: "tool-result", toolCallId: `tc${callCount}`, toolName: "echo", output: `result${callCount}` },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "All done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("echo", { description: "Echo", execute: async () => "ok" } as any);
    const msg = await agent.prompt("Use echo twice");
    expect(msg.content).toBe("All done");
    expect(callCount).toBe(3);
  });

  test("maxSteps limit reached returns last assistant message with tool calls", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
        { type: "tool-result", toolCallId: "tc1", toolName: "echo", output: "ok" },
        { type: "finish", finishReason: "tool-calls" },
      ]));

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" }, behavior: { maxSteps: 2 } });
    agent.registerTool("echo", { description: "Echo", execute: async () => "ok" } as any);
    const msg = await agent.prompt("Loop forever");
    // With the P2-F2 fix, tool-call assistant messages are returned instead of the fallback
    expect(msg.content).toBe("");
    expect(msg.toolCalls).toBeTruthy();
  });

  test("status lifecycle: idle -> streaming -> executing_tool -> streaming -> idle", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: {} },
          { type: "tool-result", toolCallId: "tc1", toolName: "echo", output: "ok" },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("echo", { description: "Echo", execute: async () => "ok" } as any);
    const statuses: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "status_change") statuses.push(e.status);
    });
    await agent.prompt("Hi");
    expect(statuses).toContain("streaming");
    expect(statuses).toContain("executing_tool");
    expect(statuses[statuses.length - 1]).toBe("idle");
  });

  test("tool results persisted in session", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          { type: "tool-call", toolCallId: "tc1", toolName: "echo", input: { text: "hi" } },
          { type: "tool-result", toolCallId: "tc1", toolName: "echo", output: "echo-result" },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Final" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("echo", { description: "Echo" } as any);
    await agent.prompt("Use echo");
    const msgs = agent.getSession().getMessages();
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
  });

  test("tool error emitted as error event", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "tool-error", error: "Tool execution failed" },
        { type: "text-delta", text: "After error" },
        { type: "finish", finishReason: "stop" },
      ]));

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const errors: any[] = [];
    agent.onEvent((e) => {
      if (e.type === "error") errors.push(e);
    });
    await agent.prompt("Hi");
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
