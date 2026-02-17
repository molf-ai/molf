import { describe, test, expect } from "bun:test";
import { Session, generateMessageId, convertToModelMessages } from "../src/session.js";

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

// --- Multimodal toModelMessages tests (Phase 2) ---

describe("toModelMessages with attachments", () => {
  test("text-only user message: unchanged behavior", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hello" });
    const msgs = session.toModelMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    // Should be plain string, not content array
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).toBe("hello");
  });

  test("user message with image attachment returns ImagePart", () => {
    const session = new Session();
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    session.addMessage({
      role: "user",
      content: "What is in this image?",
      attachments: [{ data: imageData, mimeType: "image/png", filename: "test.png" }],
    });
    const msgs = session.toModelMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(Array.isArray(msgs[0].content)).toBe(true);

    const parts = msgs[0].content as any[];
    expect(parts).toHaveLength(2); // TextPart + ImagePart

    // First part: text
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toBe("What is in this image?");

    // Second part: image
    expect(parts[1].type).toBe("image");
    expect(parts[1].image).toEqual(imageData);
    expect(parts[1].mediaType).toBe("image/png");
  });

  test("user message with PDF attachment returns FilePart", () => {
    const session = new Session();
    const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header
    session.addMessage({
      role: "user",
      content: "Summarize this document",
      attachments: [{ data: pdfData, mimeType: "application/pdf", filename: "doc.pdf" }],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    expect(parts).toHaveLength(2);

    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toBe("Summarize this document");

    expect(parts[1].type).toBe("file");
    expect(parts[1].data).toEqual(pdfData);
    expect(parts[1].mediaType).toBe("application/pdf");
  });

  test("user message with empty content + image: only ImagePart, no TextPart", () => {
    const session = new Session();
    const imageData = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG header
    session.addMessage({
      role: "user",
      content: "",
      attachments: [{ data: imageData, mimeType: "image/jpeg" }],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];

    // Should have only the ImagePart (no TextPart for empty content)
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image");
    expect(parts[0].image).toEqual(imageData);
    expect(parts[0].mediaType).toBe("image/jpeg");
  });

  test("user message with multiple attachments", () => {
    const session = new Session();
    const img = new Uint8Array([1, 2, 3]);
    const pdf = new Uint8Array([4, 5, 6]);
    session.addMessage({
      role: "user",
      content: "Analyze these",
      attachments: [
        { data: img, mimeType: "image/jpeg" },
        { data: pdf, mimeType: "application/pdf", filename: "report.pdf" },
      ],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    expect(parts).toHaveLength(3); // text + image + file

    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image");
    expect(parts[1].image).toEqual(img);
    expect(parts[2].type).toBe("file");
    expect(parts[2].data).toEqual(pdf);
  });

  test("user message with empty attachments array: unchanged (plain string)", () => {
    const session = new Session();
    session.addMessage({
      role: "user",
      content: "no media",
      attachments: [],
    });
    const msgs = session.toModelMessages();
    // Empty array treated as no attachments → plain string
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).toBe("no media");
  });

  test("assistant messages unchanged by attachments feature", () => {
    const session = new Session();
    session.addMessage({ role: "assistant", content: "I can help" });
    const msgs = session.toModelMessages();
    expect(msgs[0].role).toBe("assistant");
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).toBe("I can help");
  });

  test("tool messages unchanged by attachments feature", () => {
    const session = new Session();
    session.addMessage({
      role: "tool",
      content: '{"result":"ok"}',
      toolCallId: "tc1",
      toolName: "test",
    });
    const msgs = session.toModelMessages();
    expect(msgs[0].role).toBe("tool");
    const content = msgs[0].content as any[];
    expect(content[0].type).toBe("tool-result");
  });

  test("audio attachment mapped as file (non-image)", () => {
    const session = new Session();
    const audio = new Uint8Array([0, 1, 2]);
    session.addMessage({
      role: "user",
      content: "Transcribe this",
      attachments: [{ data: audio, mimeType: "audio/mpeg" }],
    });
    const msgs = session.toModelMessages();
    const parts = msgs[0].content as any[];
    // Audio is non-image, so it gets mapped to FilePart
    const audioPart = parts.find((p: any) => p.type === "file");
    expect(audioPart).toBeTruthy();
    expect(audioPart.data).toEqual(audio);
    expect(audioPart.mediaType).toBe("audio/mpeg");
  });
});

// --- Session.addMessage with attachments ---

describe("Session addMessage with attachments", () => {
  test("addMessage stores attachments on user message", () => {
    const session = new Session();
    const imageData = new Uint8Array([1, 2, 3]);
    const msg = session.addMessage({
      role: "user",
      content: "photo",
      attachments: [{ data: imageData, mimeType: "image/jpeg" }],
    });
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0].data).toEqual(imageData);
    expect(msg.attachments![0].mimeType).toBe("image/jpeg");
  });

  test("addMessage without attachments has undefined attachments", () => {
    const session = new Session();
    const msg = session.addMessage({ role: "user", content: "text only" });
    expect(msg.attachments).toBeUndefined();
  });
});

describe("convertToModelMessages", () => {
  test("produces same result as session.toModelMessages()", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "hello" });
    session.addMessage({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ toolCallId: "tc1", toolName: "echo", args: { text: "hi" } }],
    });
    session.addMessage({
      role: "tool",
      content: '{"result":"hi"}',
      toolCallId: "tc1",
      toolName: "echo",
    });
    session.addMessage({ role: "assistant", content: "Done" });

    const fromMethod = session.toModelMessages();
    const fromFn = convertToModelMessages(session.getMessages());
    expect(fromFn).toEqual(fromMethod);
  });

  test("works with empty messages array", () => {
    expect(convertToModelMessages([])).toEqual([]);
  });
});

describe("generateMessageId", () => {
  test("format", () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_/);
    expect(id.length).toBeGreaterThanOrEqual(16);
  });
});
