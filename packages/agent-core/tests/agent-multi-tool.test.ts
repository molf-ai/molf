import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";

const { Agent } = await import("../src/agent.js");

describe("Agent multi-tool call in single step", () => {
  test("multiple tool calls in a single step are all persisted", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        // Simulate the LLM issuing two tool calls in one step
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_1",
            toolName: "read_file",
            input: { path: "/a.txt" },
          },
          {
            type: "tool-call",
            toolCallId: "tc_2",
            toolName: "read_file",
            input: { path: "/b.txt" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_1",
            toolName: "read_file",
            output: "contents of a",
          },
          {
            type: "tool-result",
            toolCallId: "tc_2",
            toolName: "read_file",
            output: "contents of b",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Both files read" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 5 },
    });
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async (args: any) => `contents of ${args.path}`,
    } as any);

    const result = await agent.prompt("Read both files");

    expect(result.content).toBe("Both files read");

    const messages = agent.getSession().getMessages();

    // Should have: user, assistant (2 tool calls), tool result 1, tool result 2, assistant (text)
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].content).toBe("contents of a");
    expect(toolMessages[1].content).toBe("contents of b");

    // The assistant message should have 2 tool calls
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    expect(assistantWithTools).toBeTruthy();
    expect(assistantWithTools!.toolCalls).toHaveLength(2);
    expect(assistantWithTools!.toolCalls![0].toolName).toBe("read_file");
    expect(assistantWithTools!.toolCalls![1].toolName).toBe("read_file");
  });

  test("multi-tool step emits tool_call_start and tool_call_end for each tool", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_a",
            toolName: "echo",
            input: { text: "hello" },
          },
          {
            type: "tool-call",
            toolCallId: "tc_b",
            toolName: "echo",
            input: { text: "world" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_a",
            toolName: "echo",
            output: "hello",
          },
          {
            type: "tool-result",
            toolCallId: "tc_b",
            toolName: "echo",
            output: "world",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 5 },
    });
    agent.registerTool("echo", {
      description: "Echo",
      execute: async (args: any) => args.text,
    } as any);

    const events: any[] = [];
    agent.onEvent((e) => events.push(e));

    await agent.prompt("Echo twice");

    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0].toolCallId).toBe("tc_a");
    expect(starts[1].toolCallId).toBe("tc_b");
    expect(ends[0].toolCallId).toBe("tc_a");
    expect(ends[1].toolCallId).toBe("tc_b");
  });

  test("different tools in same step all work correctly", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_read",
            toolName: "read_file",
            input: { path: "/file.txt" },
          },
          {
            type: "tool-call",
            toolCallId: "tc_echo",
            toolName: "echo",
            input: { text: "hi" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_read",
            toolName: "read_file",
            output: "file content",
          },
          {
            type: "tool-result",
            toolCallId: "tc_echo",
            toolName: "echo",
            output: "hi",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "All done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 5 },
    });
    agent.registerTool("read_file", {
      description: "Read",
      execute: async () => "file content",
    } as any);
    agent.registerTool("echo", {
      description: "Echo",
      execute: async (args: any) => args.text,
    } as any);

    const result = await agent.prompt("Read and echo");
    expect(result.content).toBe("All done");

    const messages = agent.getSession().getMessages();
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].toolName).toBe("read_file");
    expect(toolMsgs[1].toolName).toBe("echo");
  });
});
