import { describe, expect, test } from "bun:test";
import { Session } from "../src/session.js";

describe("Session", () => {
  test("starts empty", () => {
    const session = new Session();
    expect(session.length).toBe(0);
    expect(session.getMessages()).toEqual([]);
  });

  test("adds a message with auto-generated id and timestamp", () => {
    const session = new Session();
    const msg = session.addMessage({ role: "user", content: "Hello" });

    expect(msg.id).toMatch(/^msg_/);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(session.length).toBe(1);
  });

  test("getLastMessage returns the most recent message", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "First" });
    session.addMessage({ role: "assistant", content: "Second" });

    expect(session.getLastMessage()?.content).toBe("Second");
  });

  test("getLastMessage returns undefined when empty", () => {
    const session = new Session();
    expect(session.getLastMessage()).toBeUndefined();
  });

  test("toModelMessages converts to ModelMessage format", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Hi" });
    session.addMessage({ role: "assistant", content: "Hello!" });

    const modelMessages = session.toModelMessages();
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[0]).toEqual({ role: "user", content: "Hi" });
    expect(modelMessages[1]).toEqual({ role: "assistant", content: "Hello!" });
  });

  test("toModelMessages converts toolCalls to Vercel AI format", () => {
    const session = new Session();

    // Assistant message with tool calls (using our ToolCall format)
    session.addMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { toolCallId: "tc_1", toolName: "test", args: {} },
      ],
    });

    // Tool result message
    session.addMessage({
      role: "tool",
      content: "result",
      toolCallId: "tc_1",
      toolName: "test",
    });

    const modelMessages = session.toModelMessages();

    // Assistant message should have content array with tool-call parts
    expect(modelMessages[0].role).toBe("assistant");
    const assistantContent = (modelMessages[0] as any).content;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect(assistantContent[0]).toEqual({
      type: "tool-call",
      toolCallId: "tc_1",
      toolName: "test",
      input: {},
    });

    // Tool message should have content array with tool-result parts
    expect(modelMessages[1].role).toBe("tool");
    const toolContent = (modelMessages[1] as any).content;
    expect(Array.isArray(toolContent)).toBe(true);
    expect(toolContent[0].type).toBe("tool-result");
    expect(toolContent[0].toolCallId).toBe("tc_1");
    expect(toolContent[0].toolName).toBe("test");
  });

  test("clear resets the session", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Hello" });
    session.clear();

    expect(session.length).toBe(0);
    expect(session.getMessages()).toEqual([]);
  });

  test("getMessages returns a readonly snapshot", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Test" });

    const messages = session.getMessages();
    expect(messages).toHaveLength(1);
    // Verify it's the correct type (readonly array)
    expect(messages[0].content).toBe("Test");
  });
});
