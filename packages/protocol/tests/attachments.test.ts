import { describe, test, expect } from "bun:test";
import {
  fileRefSchema,
  fileRefInputSchema,
  sessionMessageSchema,
  agentPromptInput,
  agentUploadInput,
  workerUploadResultInput,
  workerToolResultInput,
  lastMessagePreview,
  MAX_ATTACHMENT_BYTES,
} from "../src/index.js";

// --- fileRefSchema ---

describe("fileRefSchema", () => {
  test("valid with all fields", () => {
    const result = fileRefSchema.safeParse({
      path: ".molf/uploads/abc-123.jpg",
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      size: 12345,
    });
    expect(result.success).toBe(true);
  });

  test("valid without optional fields", () => {
    const result = fileRefSchema.safeParse({
      path: ".molf/uploads/abc-123.png",
      mimeType: "image/png",
    });
    expect(result.success).toBe(true);
  });

  test("missing path fails", () => {
    const result = fileRefSchema.safeParse({
      mimeType: "image/jpeg",
    });
    expect(result.success).toBe(false);
  });

  test("missing mimeType fails", () => {
    const result = fileRefSchema.safeParse({
      path: ".molf/uploads/abc.jpg",
    });
    expect(result.success).toBe(false);
  });

  test("empty path fails", () => {
    const result = fileRefSchema.safeParse({
      path: "",
      mimeType: "image/jpeg",
    });
    expect(result.success).toBe(false);
  });
});

// --- fileRefInputSchema ---

describe("fileRefInputSchema", () => {
  test("valid with path and mimeType", () => {
    const result = fileRefInputSchema.safeParse({
      path: ".molf/uploads/test.png",
      mimeType: "image/png",
    });
    expect(result.success).toBe(true);
  });

  test("missing path fails", () => {
    const result = fileRefInputSchema.safeParse({
      mimeType: "image/png",
    });
    expect(result.success).toBe(false);
  });

  test("missing mimeType fails", () => {
    const result = fileRefInputSchema.safeParse({
      path: ".molf/uploads/test.png",
    });
    expect(result.success).toBe(false);
  });
});

// --- sessionMessageSchema with FileRef attachments ---

describe("sessionMessageSchema with attachments", () => {
  test("user message without attachments (backward compat)", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("user message with FileRef attachments", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_2",
      role: "user",
      content: "Check this image",
      attachments: [
        { path: ".molf/uploads/abc.jpg", mimeType: "image/jpeg", filename: "photo.jpg" },
      ],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toHaveLength(1);
      expect(result.data.attachments![0].path).toBe(".molf/uploads/abc.jpg");
    }
  });

  test("user message with multiple attachments", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_3",
      role: "user",
      content: "",
      attachments: [
        { path: ".molf/uploads/a.jpg", mimeType: "image/jpeg" },
        { path: ".molf/uploads/b.pdf", mimeType: "application/pdf", filename: "doc.pdf", size: 2048 },
      ],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toHaveLength(2);
    }
  });

  test("user message with empty attachments array", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_4",
      role: "user",
      content: "text only",
      attachments: [],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("assistant message without attachments unchanged", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_5",
      role: "assistant",
      content: "I can help with that",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("invalid attachment in array fails", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_6",
      role: "user",
      content: "bad",
      attachments: [{ invalid: true }],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});

// --- agentPromptInput with fileRefs ---

describe("agentPromptInput with fileRefs", () => {
  test("without fileRefs (backward compat)", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "Hello",
    });
    expect(result.success).toBe(true);
  });

  test("with fileRefs", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "Describe this",
      fileRefs: [
        { path: ".molf/uploads/img.jpg", mimeType: "image/jpeg" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileRefs).toHaveLength(1);
      expect(result.data.fileRefs![0].path).toBe(".molf/uploads/img.jpg");
    }
  });

  test("with empty text and fileRef", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "",
      fileRefs: [
        { path: ".molf/uploads/photo.png", mimeType: "image/png" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("with multiple fileRefs", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "Multiple files",
      fileRefs: [
        { path: ".molf/uploads/a.jpg", mimeType: "image/jpeg" },
        { path: ".molf/uploads/b.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileRefs).toHaveLength(2);
    }
  });

  test("exceeds max 10 fileRefs fails", () => {
    const fileRefs = Array.from({ length: 11 }, (_, i) => ({
      path: `.molf/uploads/file${i}.jpg`,
      mimeType: "image/jpeg",
    }));
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "Too many",
      fileRefs,
    });
    expect(result.success).toBe(false);
  });

  test("invalid fileRef fails", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "sess-1",
      text: "bad",
      fileRefs: [{ mimeType: "image/jpeg" }], // missing path
    });
    expect(result.success).toBe(false);
  });
});

// --- agentUploadInput ---

describe("agentUploadInput", () => {
  test("valid upload input", () => {
    const result = agentUploadInput.safeParse({
      sessionId: "sess-1",
      data: "aGVsbG8=",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(result.success).toBe(true);
  });

  test("missing data fails", () => {
    const result = agentUploadInput.safeParse({
      sessionId: "sess-1",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(result.success).toBe(false);
  });

  test("empty data fails", () => {
    const result = agentUploadInput.safeParse({
      sessionId: "sess-1",
      data: "",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(result.success).toBe(false);
  });
});

// --- workerToolResultInput ---

describe("workerToolResultInput", () => {
  test("basic tool result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: "done",
    });
    expect(result.success).toBe(true);
  });

  test("tool result with error", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: null,
      error: "something failed",
    });
    expect(result.success).toBe(true);
  });
});

// --- lastMessagePreview ---

describe("lastMessagePreview", () => {
  test("text-only message returns content", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Hello world",
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("Hello world");
  });

  test("message with no attachments returns content", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Just text",
      attachments: undefined,
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("Just text");
  });

  test("message with empty attachments array returns content", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Just text",
      attachments: [],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("Just text");
  });

  test("image attachment with text", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Look at this",
      attachments: [{ path: ".molf/uploads/a.jpg", mimeType: "image/jpeg" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[image] Look at this");
  });

  test("image attachment without text", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "",
      attachments: [{ path: ".molf/uploads/a.png", mimeType: "image/png" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[image]");
  });

  test("document attachment (PDF)", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Review this",
      attachments: [{ path: ".molf/uploads/d.pdf", mimeType: "application/pdf" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[document] Review this");
  });

  test("audio attachment", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "",
      attachments: [{ path: ".molf/uploads/a.mp3", mimeType: "audio/mpeg" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[audio]");
  });

  test("video attachment", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Watch this",
      attachments: [{ path: ".molf/uploads/v.mp4", mimeType: "video/mp4" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[video] Watch this");
  });

  test("mixed attachments uses first attachment for label", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "Here are files",
      attachments: [
        { path: ".molf/uploads/a.jpg", mimeType: "image/jpeg" },
        { path: ".molf/uploads/d.pdf", mimeType: "application/pdf" },
      ],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[image] Here are files");
  });

  test("unknown mime type shows document label", () => {
    const msg = {
      id: "msg_1",
      role: "user" as const,
      content: "",
      attachments: [{ path: ".molf/uploads/f.bin", mimeType: "application/octet-stream" }],
      timestamp: Date.now(),
    };
    expect(lastMessagePreview(msg)).toBe("[document]");
  });
});

// --- MAX_ATTACHMENT_BYTES ---

describe("MAX_ATTACHMENT_BYTES", () => {
  test("is 15MB", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(15 * 1024 * 1024);
  });
});
