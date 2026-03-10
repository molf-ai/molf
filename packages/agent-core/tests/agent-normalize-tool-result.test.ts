import { describe, test, expect, vi } from "vitest";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import { makeResolvedModel } from "./_helpers.js";

import { Agent } from "../src/agent.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

const MODEL = makeResolvedModel();

/**
 * Tests for normalizeToolResult behavior: tool results are normalized
 * before session persistence. Strings pass through, arrays extract text
 * parts, everything else passes through unchanged.
 */
describe("normalizeToolResult (via Agent session persistence)", () => {
  test("string result persists as-is (typical case in v2)", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_str",
            toolName: "read_file",
            input: { path: "/file.txt" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_str",
            toolName: "read_file",
            output: "[Binary file: image.png, 100 bytes]",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async () => "[Binary file: image.png, 100 bytes]",
    } as any);

    await agent.prompt("Read the image");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();

    // String result persists directly
    expect(toolMsg!.content).toBe("[Binary file: image.png, 100 bytes]");
  });

  test("object result is JSON-stringified", async () => {
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

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
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

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
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

  test("array of text parts is joined with newlines", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_arr",
            toolName: "multi",
            input: {},
          },
          {
            type: "tool-result",
            toolCallId: "tc_arr",
            toolName: "multi",
            output: [
              { type: "text", text: "hello" },
              { type: "text", text: "world" },
            ],
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
    agent.registerTool("multi", {
      description: "Multi-part",
      execute: async () => [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    } as any);

    await agent.prompt("Test array");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toBe("hello\nworld");
  });

  test("array with mixed text and non-text parts extracts only text", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_mix",
            toolName: "mixed",
            input: {},
          },
          {
            type: "tool-result",
            toolCallId: "tc_mix",
            toolName: "mixed",
            output: [
              { type: "text", text: "hello" },
              { type: "image", image: new Uint8Array([1, 2, 3]) },
              { type: "text", text: "world" },
            ],
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
    agent.registerTool("mixed", {
      description: "Mixed",
      execute: async () => [
        { type: "text", text: "hello" },
        { type: "image", image: new Uint8Array([1, 2, 3]) },
        { type: "text", text: "world" },
      ],
    } as any);

    await agent.prompt("Test mixed");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toBe("hello\nworld");
  });

  test("empty array produces empty string", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_empty",
            toolName: "empty",
            input: {},
          },
          {
            type: "tool-result",
            toolCallId: "tc_empty",
            toolName: "empty",
            output: [],
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
    agent.registerTool("empty", {
      description: "Empty",
      execute: async () => [],
    } as any);

    await agent.prompt("Test empty");

    const messages = agent.getSession().getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toBe("");
  });
});
