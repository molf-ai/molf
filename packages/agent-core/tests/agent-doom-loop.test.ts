import { describe, test, expect, mock } from "bun:test";

let streamTextImpl: (...args: any[]) => any;

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "mock-model",
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => "mock-model",
}));

const { Agent } = await import("../src/agent.js");

function makeStream(events: any[]) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

describe("Doom loop detection", () => {
  test("injects warning after 3 identical tool calls", async () => {
    let callCount = 0;
    streamTextImpl = () => {
      callCount++;
      if (callCount <= 3) {
        // Same tool name AND same args for 3 consecutive calls
        return makeStream([
          {
            type: "tool-call",
            toolCallId: `tc_${callCount}`,
            toolName: "read_file",
            input: { path: "/etc/hosts" },
          },
          {
            type: "tool-result",
            toolCallId: `tc_${callCount}`,
            toolName: "read_file",
            output: "file contents",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      // After the warning message is injected, model produces final text
      return makeStream([
        { type: "text-delta", text: "I'll try something different" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 10 },
    });
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async () => "file contents",
    } as any);

    await agent.prompt("Read the file");

    // The warning message should have been injected into the session
    const messages = agent.getSession().getMessages();
    const warningMsg = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("repeating the same action"),
    );
    expect(warningMsg).toBeTruthy();
  });

  test("does not trigger warning with different tool args", async () => {
    let callCount = 0;
    streamTextImpl = () => {
      callCount++;
      if (callCount <= 3) {
        // Same tool name but DIFFERENT args each time
        return makeStream([
          {
            type: "tool-call",
            toolCallId: `tc_${callCount}`,
            toolName: "read_file",
            input: { path: `/file${callCount}.txt` },
          },
          {
            type: "tool-result",
            toolCallId: `tc_${callCount}`,
            toolName: "read_file",
            output: `contents ${callCount}`,
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return makeStream([
        { type: "text-delta", text: "Done reading files" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 10 },
    });
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async () => "ok",
    } as any);

    await agent.prompt("Read three different files");

    const messages = agent.getSession().getMessages();
    const warningMsg = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("repeating the same action"),
    );
    expect(warningMsg).toBeUndefined();
  });

  test("does not trigger warning with different tool names", async () => {
    let callCount = 0;
    const toolNames = ["read_file", "write_file", "read_file"];
    streamTextImpl = () => {
      callCount++;
      if (callCount <= 3) {
        const toolName = toolNames[callCount - 1];
        return makeStream([
          {
            type: "tool-call",
            toolCallId: `tc_${callCount}`,
            toolName,
            input: { path: "/same.txt" },
          },
          {
            type: "tool-result",
            toolCallId: `tc_${callCount}`,
            toolName,
            output: "ok",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return makeStream([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 10 },
    });
    agent.registerTool("read_file", { description: "Read", execute: async () => "ok" } as any);
    agent.registerTool("write_file", { description: "Write", execute: async () => "ok" } as any);

    await agent.prompt("Use multiple tools");

    const messages = agent.getSession().getMessages();
    const warningMsg = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("repeating the same action"),
    );
    expect(warningMsg).toBeUndefined();
  });

  test("does not trigger warning with only 2 identical calls", async () => {
    let callCount = 0;
    streamTextImpl = () => {
      callCount++;
      if (callCount <= 2) {
        return makeStream([
          {
            type: "tool-call",
            toolCallId: `tc_${callCount}`,
            toolName: "echo",
            input: { text: "same" },
          },
          {
            type: "tool-result",
            toolCallId: `tc_${callCount}`,
            toolName: "echo",
            output: "same",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      return makeStream([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 10 },
    });
    agent.registerTool("echo", { description: "Echo", execute: async () => "ok" } as any);

    await agent.prompt("Echo twice");

    const messages = agent.getSession().getMessages();
    const warningMsg = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("repeating the same action"),
    );
    expect(warningMsg).toBeUndefined();
  });
});
