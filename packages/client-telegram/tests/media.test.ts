import { describe, test, expect, vi, beforeEach } from "vitest";
import { downloadTelegramMedia, FileTooLargeError } from "../src/media.js";
import { MessageHandler } from "../src/handler.js";

// --- downloadTelegramMedia tests ---

describe("downloadTelegramMedia", () => {
  test("downloads photo (picks largest resolution)", async () => {
    const mockBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      }),
    );
    globalThis.fetch = mockFetch as any;

    const ctx = {
      message: {
        photo: [
          { file_id: "small", file_size: 1000, width: 100, height: 100 },
          { file_id: "medium", file_size: 5000, width: 500, height: 500 },
          { file_id: "large", file_size: 20000, width: 1280, height: 960 },
        ],
      },
      api: {
        getFile: vi.fn(async (fileId: string) => ({
          file_id: fileId,
          file_path: `photos/${fileId}.jpg`,
        })),
      },
    } as any;

    const result = await downloadTelegramMedia(ctx, "test-bot-token");

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("photo.jpg");
    expect(result.buffer).toEqual(mockBuffer);

    // Should have picked the largest photo
    expect(ctx.api.getFile).toHaveBeenCalledWith("large");

    // Should have used the correct download URL
    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain("test-bot-token");
    expect(fetchUrl).toContain("photos/large.jpg");
  });

  test("downloads document with metadata", async () => {
    const mockBuffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      }),
    ) as any;

    const ctx = {
      message: {
        document: {
          file_id: "doc-123",
          mime_type: "application/pdf",
          file_name: "report.pdf",
          file_size: 5000,
        },
      },
      api: {
        getFile: vi.fn(async () => ({
          file_id: "doc-123",
          file_path: "documents/report.pdf",
        })),
      },
    } as any;

    const result = await downloadTelegramMedia(ctx, "token");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("report.pdf");
    expect(result.buffer).toEqual(mockBuffer);
  });

  test("downloads sticker (non-animated as webp)", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      }),
    ) as any;

    const ctx = {
      message: {
        sticker: {
          file_id: "sticker-1",
          is_animated: false,
          file_size: 2000,
        },
      },
      api: {
        getFile: vi.fn(async () => ({
          file_id: "sticker-1",
          file_path: "stickers/sticker-1.webp",
        })),
      },
    } as any;

    const result = await downloadTelegramMedia(ctx, "token");
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("sticker.webp");
  });

  test("downloads audio with default mime type", async () => {
    const mockBuffer = new Uint8Array([1]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
      }),
    ) as any;

    const ctx = {
      message: {
        audio: {
          file_id: "audio-1",
          file_size: 1000,
          // no mime_type — should default
        },
      },
      api: {
        getFile: vi.fn(async () => ({
          file_id: "audio-1",
          file_path: "audio/audio-1.mp3",
        })),
      },
    } as any;

    const result = await downloadTelegramMedia(ctx, "token");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.filename).toBe("audio.mp3");
  });

  test("pre-download size validation rejects oversized file", async () => {
    const ctx = {
      message: {
        photo: [
          { file_id: "huge", file_size: 110 * 1024 * 1024, width: 4000, height: 3000 },
        ],
      },
      api: {
        getFile: vi.fn(async () => ({})),
      },
    } as any;

    try {
      await downloadTelegramMedia(ctx, "token");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(FileTooLargeError);
      expect((err as FileTooLargeError).message).toContain("too large");
    }
  });

  test("throws for unsupported media type", async () => {
    const ctx = {
      message: {
        // No photo, document, audio, etc.
        text: "just text",
      },
    } as any;

    try {
      await downloadTelegramMedia(ctx, "token");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("No supported media");
    }
  });

  test("throws when no message", async () => {
    const ctx = { message: undefined } as any;

    try {
      await downloadTelegramMedia(ctx, "token");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("No supported media");
    }
  });

  test("throws when Telegram returns no file_path", async () => {
    const ctx = {
      message: {
        photo: [{ file_id: "id", file_size: 100 }],
      },
      api: {
        getFile: vi.fn(async () => ({ file_id: "id" })), // no file_path
      },
    } as any;

    try {
      await downloadTelegramMedia(ctx, "token");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("file path");
    }
  });

  test("throws on HTTP error during download", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404 }),
    ) as any;

    const ctx = {
      message: {
        photo: [{ file_id: "id", file_size: 100 }],
      },
      api: {
        getFile: vi.fn(async () => ({
          file_id: "id",
          file_path: "photos/id.jpg",
        })),
      },
    } as any;

    try {
      await downloadTelegramMedia(ctx, "token");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("HTTP 404");
    }
  });
});

// --- FileTooLargeError ---

describe("FileTooLargeError", () => {
  test("includes human-readable size in message", () => {
    const err = new FileTooLargeError("image/jpeg", 15_000_000, 10_485_760);
    expect(err.message).toContain("10MB");
    expect(err.name).toBe("FileTooLargeError");
    expect(err.mimeType).toBe("image/jpeg");
    expect(err.actualSize).toBe(15_000_000);
    expect(err.maxSize).toBe(10_485_760);
  });
});

// --- handleMedia integration ---

describe("MessageHandler.handleMedia", () => {
  let handler: MessageHandler;
  let sessionMapMock: any;
  let connectionMock: any;
  let rendererMock: any;
  let apiMocks: any;

  beforeEach(() => {
    sessionMapMock = {
      getOrCreate: vi.fn(async () => "session-1"),
    };

    connectionMock = {
      client: {
        agent: {
          prompt: vi.fn(async () => ({ messageId: "msg-1" })),
        },
        fs: {
          upload: vi.fn(async () => ({ path: ".molf/uploads/test-file.jpg", mimeType: "image/jpeg", size: 100 })),
        },
      },
    };

    rendererMock = {
      startSession: vi.fn(() => {}),
    };

    apiMocks = {
      sendChatAction: vi.fn(() => Promise.resolve()),
      setMessageReaction: vi.fn(() => Promise.resolve()),
      getFile: vi.fn(async () => ({
        file_id: "test-file",
        file_path: "photos/test.jpg",
      })),
    };

    handler = new MessageHandler({
      sessionMap: sessionMapMock,
      connection: connectionMock,
      renderer: rendererMock,
      approvalManager: { watchSession: vi.fn(() => {}) },
      botToken: "test-bot-token",
    });
  });

  test("downloads, uploads, and submits photo with caption via fileRef", async () => {
    const photoBuffer = new Uint8Array([0xff, 0xd8, 0xff]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(photoBuffer.buffer),
      }),
    ) as any;

    const ctx = {
      chat: { id: 100, type: "private" },
      message: {
        message_id: 1,
        caption: "What is this?",
        photo: [{ file_id: "photo-1", file_size: 5000 }],
      },
      from: { id: 1234 },
      api: apiMocks,
      reply: vi.fn(() => Promise.resolve()),
    } as any;

    await handler.handleMedia(ctx);

    // Should have uploaded first
    expect(connectionMock.client.fs.upload).toHaveBeenCalled();
    const uploadCall = connectionMock.client.fs.upload.mock.calls[0][0];
    expect(uploadCall.sessionId).toBe("session-1");
    expect(uploadCall.file).toBeInstanceOf(File);
    expect(uploadCall.file.type).toBe("image/jpeg");
    expect(uploadCall.file.name).toBe("photo.jpg");

    // Then should have prompted with fileRef
    expect(connectionMock.client.agent.prompt).toHaveBeenCalled();
    const promptCall = connectionMock.client.agent.prompt.mock.calls[0][0];
    expect(promptCall.sessionId).toBe("session-1");
    expect(promptCall.text).toBe("What is this?");
    expect(promptCall.fileRefs).toHaveLength(1);
    expect(promptCall.fileRefs[0].path).toBe(".molf/uploads/test-file.jpg");
    expect(promptCall.fileRefs[0].mimeType).toBe("image/jpeg");
  });

  test("uses sticker emoji as text when no caption", async () => {
    const stickerBuffer = new Uint8Array([1, 2]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(stickerBuffer.buffer),
      }),
    ) as any;

    const ctx = {
      chat: { id: 100, type: "private" },
      message: {
        message_id: 1,
        sticker: {
          file_id: "sticker-1",
          is_animated: false,
          file_size: 1000,
          emoji: "😀",
        },
      },
      from: { id: 1234 },
      api: apiMocks,
      reply: vi.fn(() => Promise.resolve()),
    } as any;

    await handler.handleMedia(ctx);

    const promptCall = connectionMock.client.agent.prompt.mock.calls[0][0];
    expect(promptCall.text).toBe("😀");
  });

  test("ignores messages without chat", async () => {
    const ctx = {
      chat: undefined,
      message: {
        photo: [{ file_id: "id", file_size: 100 }],
      },
    } as any;

    await handler.handleMedia(ctx);
    expect(connectionMock.client.agent.prompt).not.toHaveBeenCalled();
  });

  test("replies with error on FileTooLargeError", async () => {
    const ctx = {
      chat: { id: 100, type: "private" },
      message: {
        message_id: 1,
        photo: [{ file_id: "huge", file_size: 110 * 1024 * 1024 }],
      },
      from: { id: 1234 },
      api: apiMocks,
      reply: vi.fn(() => Promise.resolve()),
    } as any;

    await handler.handleMedia(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).toContain("too large");
    // Should NOT have submitted prompt
    expect(connectionMock.client.agent.prompt).not.toHaveBeenCalled();
  });

  test("replies with generic error on download failure", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500 }),
    ) as any;

    const origError = console.error;
    console.error = vi.fn(() => {});
    try {
      const ctx = {
        chat: { id: 100, type: "private" },
        message: {
          message_id: 1,
          photo: [{ file_id: "fail", file_size: 100 }],
        },
        from: { id: 1234 },
        api: apiMocks,
        reply: vi.fn(() => Promise.resolve()),
      } as any;

      await handler.handleMedia(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain("Something went wrong");
    } finally {
      console.error = origError;
    }
  });
});
