import { describe, test, expect } from "bun:test";
import { Session, generateMessageId } from "../src/session.js";

describe("Session", () => {
  test("addMessage assigns id and timestamp", () => {
    const session = new Session();
    const msg = session.addMessage({ role: "user", content: "hello" });
    expect(msg.id).toMatch(/^msg_/);
    expect(typeof msg.timestamp).toBe("number");
  });

  test("addMessage for user role", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hi" });
    const msgs = session.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hi");
  });

  test("addMessage for assistant with toolCalls", () => {
    const session = new Session();
    const msg = session.addMessage({
      role: "assistant",
      content: "Let me help",
      toolCalls: [{ toolCallId: "tc1", toolName: "shell", args: { cmd: "ls" } }],
    });
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].toolName).toBe("shell");
  });

  test("addMessage for tool role", () => {
    const session = new Session();
    const msg = session.addMessage({
      role: "tool",
      content: '{"result":"ok"}',
      toolCallId: "tc1",
      toolName: "shell",
    });
    expect(msg.toolCallId).toBe("tc1");
    expect(msg.toolName).toBe("shell");
  });

  test("getMessages returns readonly array", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "a" });
    session.addMessage({ role: "user", content: "b" });
    expect(session.getMessages().length).toBe(2);
  });

  test("getLastMessage returns most recent", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "first" });
    session.addMessage({ role: "user", content: "second" });
    expect(session.getLastMessage()?.content).toBe("second");
  });

  test("getLastMessage on empty session", () => {
    const session = new Session();
    expect(session.getLastMessage()).toBeUndefined();
  });

  test("clear removes all messages", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "a" });
    session.clear();
    expect(session.length).toBe(0);
  });

  test("length getter", () => {
    const session = new Session();
    expect(session.length).toBe(0);
    session.addMessage({ role: "user", content: "a" });
    expect(session.length).toBe(1);
    session.addMessage({ role: "user", content: "b" });
    expect(session.length).toBe(2);
  });

  test("serialize produces a deep copy", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "original" });
    const serialized = session.serialize();
    session.addMessage({ role: "user", content: "new" });
    expect(serialized.messages.length).toBe(1);
  });

  test("Session.deserialize restores messages", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hello" });
    session.addMessage({ role: "assistant", content: "world" });
    const serialized = session.serialize();
    const restored = Session.deserialize(serialized);
    expect(restored.length).toBe(2);
    expect(restored.getMessages()[0].content).toBe("hello");
    expect(restored.getMessages()[1].content).toBe("world");
  });

  test("round-trip serialize/deserialize", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hi" });
    session.addMessage({
      role: "assistant",
      content: "hi back",
      toolCalls: [{ toolCallId: "tc1", toolName: "echo", args: { text: "hello" } }],
    });
    session.addMessage({ role: "tool", content: '{"result":"hello"}', toolCallId: "tc1", toolName: "echo" });

    const restored = Session.deserialize(session.serialize());
    expect(restored.length).toBe(3);
    expect(restored.getMessages()[1].toolCalls?.[0].toolName).toBe("echo");
    expect(restored.getMessages()[2].toolCallId).toBe("tc1");
  });
});

describe("toModelMessages", () => {
  test("user message", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hello" });
    const msgs = session.toModelMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
  });

  test("plain assistant", () => {
    const session = new Session();
    session.addMessage({ role: "assistant", content: "world" });
    const msgs = session.toModelMessages();
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("world");
  });

  test("assistant with tool calls", () => {
    const session = new Session();
    session.addMessage({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ toolCallId: "tc1", toolName: "echo", args: { text: "hi" } }],
    });
    const msgs = session.toModelMessages();
    expect(msgs[0].role).toBe("assistant");
    expect(Array.isArray(msgs[0].content)).toBe(true);
    const parts = msgs[0].content as unknown[];
    expect(parts.length).toBe(2);
  });

  test("tool result JSON", () => {
    const session = new Session();
    session.addMessage({
      role: "tool",
      content: '{"value":42}',
      toolCallId: "tc1",
      toolName: "calc",
    });
    const msgs = session.toModelMessages();
    expect(msgs[0].role).toBe("tool");
    const content = msgs[0].content as any[];
    expect(content[0].type).toBe("tool-result");
    expect(content[0].output.type).toBe("json");
  });

  test("tool result plain text", () => {
    const session = new Session();
    session.addMessage({
      role: "tool",
      content: "plain text output",
      toolCallId: "tc1",
      toolName: "shell",
    });
    const msgs = session.toModelMessages();
    const content = msgs[0].content as any[];
    expect(content[0].output.type).toBe("text");
    expect(content[0].output.value).toBe("plain text output");
  });

  test("empty session", () => {
    const session = new Session();
    expect(session.toModelMessages()).toHaveLength(0);
  });

  test("assistant with empty toolCalls array", () => {
    const session = new Session();
    session.addMessage({ role: "assistant", content: "no tools", toolCalls: [] });
    const msgs = session.toModelMessages();
    expect(msgs[0].content).toBe("no tools");
  });

  test("assistant with content and toolCalls", () => {
    const session = new Session();
    session.addMessage({
      role: "assistant",
      content: "Thinking...",
      toolCalls: [{ toolCallId: "tc1", toolName: "test", args: {} }],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toBe("Thinking...");
    expect(parts[1].type).toBe("tool-call");
  });

  test("assistant with tool calls preserves providerMetadata as providerOptions", () => {
    const session = new Session();
    const metadata = { google: { thoughtSignature: "encrypted_sig_123" } };
    session.addMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "write_file",
          args: { path: "test.txt" },
          providerMetadata: metadata,
        },
      ],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    expect(parts[0].type).toBe("tool-call");
    expect(parts[0].providerOptions).toEqual(metadata);
  });

  test("assistant with tool calls omits providerOptions when no metadata", () => {
    const session = new Session();
    session.addMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { toolCallId: "tc1", toolName: "echo", args: { text: "hi" } },
      ],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    expect(parts[0].providerOptions).toBeUndefined();
  });

  test("providerMetadata survives serialize/deserialize round-trip", () => {
    const session = new Session();
    const metadata = { google: { thoughtSignature: "sig_abc" } };
    session.addMessage({
      role: "assistant",
      content: "using tool",
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "test",
          args: {},
          providerMetadata: metadata,
        },
      ],
    });

    const restored = Session.deserialize(session.serialize());
    const msgs = restored.toModelMessages();
    const parts = msgs[0].content as any[];
    const toolPart = parts.find((p: any) => p.type === "tool-call");
    expect(toolPart.providerOptions).toEqual(metadata);
  });

  test("tool message without toolName", () => {
    const session = new Session();
    session.addMessage({
      role: "tool",
      content: "result",
      toolCallId: "tc1",
    });
    const msgs = session.toModelMessages();
    const content = msgs[0].content as any[];
    expect(content[0].toolName).toBe("unknown");
  });

  test("deserialize with empty messages array", () => {
    const session = Session.deserialize({ messages: [] });
    expect(session.length).toBe(0);
  });
});

describe("generateMessageId", () => {
  test("format", () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_/);
    expect(id.length).toBeGreaterThanOrEqual(16);
  });
});
