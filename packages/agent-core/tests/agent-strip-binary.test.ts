import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";

const { Agent } = await import("../src/agent.js");

/**
 * Tests for stripBinaryData behavior: binary tool results should have their
 * `data` field stripped when persisted to the session, while non-binary
 * results pass through unchanged.
 */
describe("stripBinaryData (via Agent session persistence)", () => {
  test("Uint8Array-style binary result has data stripped from persisted message", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_bin",
            toolName: "read_file",
            input: { path: "/img.png" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_bin",
            toolName: "read_file",
            output: {
              type: "binary",
              data: "base64encodeddata",
              mimeType: "image/png",
              path: "/img.png",
              size: 100,
            },
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
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async () => ({
        type: "binary",
        data: "base64encodeddata",
        mimeType: "image/png",
        path: "/img.png",
        size: 100,
      }),
    } as any);

    await agent.prompt("Read the image");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();

    // The persisted tool message should NOT contain the base64 data
    const parsed = JSON.parse(toolMsg!.content);
    expect(parsed.data).toBeUndefined();
    expect(parsed.type).toBe("binary");
    expect(parsed.mimeType).toBe("image/png");
    expect(parsed.path).toBe("/img.png");
    expect(parsed.size).toBe(100);
  });

  test("non-binary result passes through unchanged", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_text",
            toolName: "echo",
            input: { text: "hello" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_text",
            toolName: "echo",
            output: { content: "hello world", totalLines: 1 },
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
      execute: async () => ({ content: "hello world", totalLines: 1 }),
    } as any);

    await agent.prompt("Echo something");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();

    const parsed = JSON.parse(toolMsg!.content);
    expect(parsed.content).toBe("hello world");
    expect(parsed.totalLines).toBe(1);
  });

  test("string tool result passes through as-is", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_str",
            toolName: "echo",
            input: { text: "hi" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_str",
            toolName: "echo",
            output: "plain string result",
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
      execute: async () => "plain string result",
    } as any);

    await agent.prompt("Echo");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toBe("plain string result");
  });
});
