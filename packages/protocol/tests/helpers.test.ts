import { describe, test, expect } from "vitest";
import { errorMessage, lastMessagePreview } from "../src/helpers.js";
import { MAX_ATTACHMENT_BYTES } from "../src/constants.js";
import type { SessionMessage } from "../src/types.js";

// --- errorMessage ---

describe("errorMessage", () => {
  test("extracts message from Error object", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("extracts message from TypeError", () => {
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  test("converts string to itself", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("converts boolean to string", () => {
    expect(errorMessage(false)).toBe("false");
  });

  test("converts object with toString to string representation", () => {
    const obj = { toString: () => "custom toString" };
    expect(errorMessage(obj)).toBe("custom toString");
  });

  test("converts plain object to [object Object]", () => {
    expect(errorMessage({ foo: "bar" })).toBe("[object Object]");
  });

  test("handles empty Error message", () => {
    expect(errorMessage(new Error(""))).toBe("");
  });

  test("handles Error with empty string", () => {
    expect(errorMessage(new Error())).toBe("");
  });
});

// --- lastMessagePreview ---

describe("lastMessagePreview", () => {
  function makeMsg(overrides: Partial<SessionMessage>): SessionMessage {
    return {
      id: "msg_1",
      role: "user",
      content: "",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  test("returns content when no attachments", () => {
    const msg = makeMsg({ content: "Hello world" });
    expect(lastMessagePreview(msg)).toBe("Hello world");
  });

  test("returns content when attachments array is empty", () => {
    const msg = makeMsg({ content: "Hello", attachments: [] });
    expect(lastMessagePreview(msg)).toBe("Hello");
  });

  test("prepends [image] for image attachment with content", () => {
    const msg = makeMsg({
      content: "Check this out",
      attachments: [{ path: "/img.png", mimeType: "image/png" }],
    });
    expect(lastMessagePreview(msg)).toBe("[image] Check this out");
  });

  test("returns [image] alone when no content", () => {
    const msg = makeMsg({
      content: "",
      attachments: [{ path: "/img.jpg", mimeType: "image/jpeg" }],
    });
    expect(lastMessagePreview(msg)).toBe("[image]");
  });

  test("prepends [audio] for audio attachment", () => {
    const msg = makeMsg({
      content: "Listen",
      attachments: [{ path: "/a.mp3", mimeType: "audio/mpeg" }],
    });
    expect(lastMessagePreview(msg)).toBe("[audio] Listen");
  });

  test("prepends [video] for video attachment", () => {
    const msg = makeMsg({
      content: "Watch",
      attachments: [{ path: "/v.mp4", mimeType: "video/mp4" }],
    });
    expect(lastMessagePreview(msg)).toBe("[video] Watch");
  });

  test("prepends [document] for non-media attachment", () => {
    const msg = makeMsg({
      content: "Read this",
      attachments: [{ path: "/doc.pdf", mimeType: "application/pdf" }],
    });
    expect(lastMessagePreview(msg)).toBe("[document] Read this");
  });

  test("uses first attachment for label when multiple", () => {
    const msg = makeMsg({
      content: "Multiple files",
      attachments: [
        { path: "/a.mp3", mimeType: "audio/mpeg" },
        { path: "/img.png", mimeType: "image/png" },
      ],
    });
    expect(lastMessagePreview(msg)).toBe("[audio] Multiple files");
  });
});

// --- MAX_ATTACHMENT_BYTES ---

describe("MAX_ATTACHMENT_BYTES", () => {
  test("is 100MB", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
  });
});
