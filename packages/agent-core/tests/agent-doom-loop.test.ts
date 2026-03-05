import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import { makeResolvedModel } from "./_helpers.js";

const { Agent } = await import("../src/agent.js");

const MODEL = makeResolvedModel();

describe("Doom loop detection", () => {
  test("injects warning after 3 identical tool calls", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 3) {
        // Same tool name AND same args for 3 consecutive calls
        return mockStreamText([
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
      return mockStreamText([
        { type: "text-delta", text: "I'll try something different" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 10 } },
      MODEL,
    );
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
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 3) {
        // Same tool name but DIFFERENT args each time
        return mockStreamText([
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
      return mockStreamText([
        { type: "text-delta", text: "Done reading files" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 10 } },
      MODEL,
    );
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
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 3) {
        const toolName = toolNames[callCount - 1];
        return mockStreamText([
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
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 10 } },
      MODEL,
    );
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

  test("breaks loop after consecutive doom loop detections instead of accumulating messages", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      // Every call is identical — doom loop should be detected repeatedly
      return mockStreamText([
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
    });

    const agent = new Agent(
      { behavior: { maxSteps: 10 } },
      MODEL,
    );
    agent.registerTool("read_file", {
      description: "Read a file",
      execute: async () => "file contents",
    } as any);

    await agent.prompt("Read the file");

    const messages = agent.getSession().getMessages();
    const warningMessages = messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.includes("repeating the same action"),
    );
    // Should inject only 1 warning (on first detection), then break on second detection
    expect(warningMessages.length).toBe(1);
    // Should NOT have exhausted all 10 maxSteps — the bailout should kick in earlier
    // 3 calls for first detection + 1 warning injected + 1 more call for second detection = 5 calls max
    expect(callCount).toBeLessThanOrEqual(5);
  });

  test("does not trigger warning with only 2 identical calls", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount <= 2) {
        return mockStreamText([
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
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent(
      { behavior: { maxSteps: 10 } },
      MODEL,
    );
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
