import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import type { ResolvedModel, ProviderModel } from "../src/providers/types.js";

const { Agent } = await import("../src/agent.js");

function makeResolvedModel(overrides?: Partial<ProviderModel>): ResolvedModel {
  return {
    language: "mock-model" as any,
    info: {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      api: { id: "test-model", url: "", npm: "@ai-sdk/openai" },
      capabilities: {
        reasoning: false,
        toolcall: true,
        temperature: true,
        input: { text: true, image: false, pdf: false, audio: false, video: false },
        output: { text: true, image: false, pdf: false, audio: false, video: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200000, output: 8192 },
      status: "active",
      headers: {},
      options: {},
      variants: {},
      ...overrides,
    },
  };
}

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
});
