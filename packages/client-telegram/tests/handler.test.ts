import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { waitUntil, flushAsync } from "@molf-ai/test-utils";
import { MessageHandler } from "../src/handler.js";

describe("MessageHandler", () => {
  let handler: MessageHandler;
  let sessionMapMock: any;
  let connectionMock: any;
  let rendererMock: any;
  let approvalManagerMock: any;
  let apiMocks: {
    sendChatAction: ReturnType<typeof vi.fn>;
    setMessageReaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sessionMapMock = {
      getOrCreate: vi.fn(async () => "session-1"),
    };

    connectionMock = {
      trpc: {
        agent: {
          prompt: {
            mutate: vi.fn(async () => ({ messageId: "msg-1" })),
          },
        },
      },
    };

    rendererMock = {
      startSession: vi.fn(() => {}),
    };

    approvalManagerMock = {
      watchSession: vi.fn(() => {}),
    };

    apiMocks = {
      sendChatAction: vi.fn(() => Promise.resolve()),
      setMessageReaction: vi.fn(() => Promise.resolve()),
    };

    handler = new MessageHandler({
      sessionMap: sessionMapMock,
      connection: connectionMock,
      renderer: rendererMock,
      approvalManager: approvalManagerMock,
      ackReaction: "eyes",
      bufferTimeoutMs: 50,
    });
  });

  afterEach(() => {
    handler.cleanup();
  });

  function createCtx(text: string, chatId = 100) {
    return {
      chat: { id: chatId, type: "private" },
      message: { text, message_id: 1 },
      from: { id: 1234 },
      api: apiMocks,
      reply: vi.fn(() => Promise.resolve()),
    } as any;
  }

  it("processes a normal text message", async () => {
    const ctx = createCtx("Hello bot");
    await handler.handleMessage(ctx);

    expect(sessionMapMock.getOrCreate).toHaveBeenCalledWith(100);
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "Hello bot",
    });
    expect(rendererMock.startSession).toHaveBeenCalledWith(100, "session-1");
  });

  it("sends typing action", async () => {
    const ctx = createCtx("Hello");
    await handler.handleMessage(ctx);

    expect(apiMocks.sendChatAction).toHaveBeenCalledWith(100, "typing");
  });

  it("sends ack reaction", async () => {
    const ctx = createCtx("Hello");
    await handler.handleMessage(ctx);

    expect(apiMocks.setMessageReaction).toHaveBeenCalled();
  });

  it("ignores messages without chat", async () => {
    const ctx = { chat: undefined, message: { text: "Hello" } } as any;
    await handler.handleMessage(ctx);
    expect(sessionMapMock.getOrCreate).not.toHaveBeenCalled();
  });

  it("ignores messages without text", async () => {
    const ctx = { chat: { id: 100 }, message: { text: undefined } } as any;
    await handler.handleMessage(ctx);
    expect(sessionMapMock.getOrCreate).not.toHaveBeenCalled();
  });

  it("sends error message on failure", async () => {
    connectionMock.trpc.agent.prompt.mutate = vi.fn(async () => {
      throw new Error("Server error");
    });

    const origError = console.error;
    console.error = vi.fn(() => {});
    try {
      const ctx = createCtx("Hello");
      await handler.handleMessage(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const replyCall = ctx.reply.mock.calls[0];
      expect(replyCall[0]).toContain("Something went wrong");
    } finally {
      console.error = origError;
    }
  });

  it("buffers long messages (>= 4000 chars)", async () => {
    const longText = "x".repeat(4100);
    const ctx = createCtx(longText);
    await handler.handleMessage(ctx);

    // Should NOT process immediately — buffered
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    // Wait for buffer timeout to fire
    await waitUntil(
      () => connectionMock.trpc.agent.prompt.mutate.mock.calls.length >= 1,
      2_000,
      "buffer flush",
    );

    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: longText,
    });
  });

  it("appends subsequent fragments to active buffer", async () => {
    const part1 = "x".repeat(4100);
    const part2 = "y".repeat(200);

    const ctx1 = createCtx(part1);
    await handler.handleMessage(ctx1);

    // Short follow-up should be buffered too (since buffer is active)
    const ctx2 = createCtx(part2);
    await handler.handleMessage(ctx2);

    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    // Wait for buffer timeout
    await waitUntil(
      () => connectionMock.trpc.agent.prompt.mutate.mock.calls.length >= 1,
      2_000,
      "buffer flush",
    );

    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledTimes(1);
    const call = connectionMock.trpc.agent.prompt.mutate.mock.calls[0];
    expect(call[0].text).toBe(`${part1}\n${part2}`);
  });

  it("flushes buffer when max parts reached", async () => {
    // Send 13 long messages — should flush at 12
    for (let i = 0; i < 13; i++) {
      const ctx = createCtx("x".repeat(4100), 200);
      await handler.handleMessage(ctx);
    }

    // After 12 parts, buffer should have flushed
    await waitUntil(
      () => connectionMock.trpc.agent.prompt.mutate.mock.calls.length >= 1,
      2_000,
      "buffer flush on max parts",
    );

    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
  });

  it("handles reaction API not available gracefully", async () => {
    apiMocks.setMessageReaction = vi.fn(() =>
      Promise.reject(new Error("Bad Request: REACTION_INVALID")),
    );

    const ctx = createCtx("Hello");
    await handler.handleMessage(ctx);

    // Should still process the message despite reaction failure
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
  });

  it("cleanup clears pending buffers", async () => {
    const longText = "x".repeat(4100);
    const ctx = createCtx(longText);
    await handler.handleMessage(ctx);

    handler.cleanup();

    // After cleanup, the buffer timeout shouldn't fire (clearTimeout already ran)
    await flushAsync();
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();
  });

  // --- New tests for improved coverage ---

  it("flushes buffer when max size exceeded", async () => {
    // First message fills the buffer
    const bigText = "x".repeat(40_000);
    const ctx1 = createCtx(bigText, 300);
    await handler.handleMessage(ctx1);

    // Second message pushes past MAX_BUFFER_SIZE (50KB)
    const pushText = "y".repeat(15_000);
    const ctx2 = createCtx(pushText, 300);
    await handler.handleMessage(ctx2);

    // Buffer should have flushed due to size limit
    await flushAsync();
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
    const call = connectionMock.trpc.agent.prompt.mutate.mock.calls[0];
    // Flushed text is the first message only (the overflow triggers flush of existing)
    expect(call[0].text).toBe(bigText);
  });

  it("buffer timeout resets on each new fragment", async () => {
    const part1 = "x".repeat(4100);
    const ctx1 = createCtx(part1, 400);
    await handler.handleMessage(ctx1);

    // Immediately NOT flushed (buffer just started)
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    // Send another part — should reset the timer
    const part2 = "y".repeat(200);
    const ctx2 = createCtx(part2, 400);
    await handler.handleMessage(ctx2);

    // Still NOT flushed right after reset
    await flushAsync();
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    // Wait for the reset timer to expire
    await waitUntil(
      () => connectionMock.trpc.agent.prompt.mutate.mock.calls.length >= 1,
      2_000,
      "buffer flush after reset",
    );
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledTimes(1);
    const call = connectionMock.trpc.agent.prompt.mutate.mock.calls[0];
    expect(call[0].text).toBe(`${part1}\n${part2}`);
  });

  it("processes short messages from different chats independently", async () => {
    const ctx1 = createCtx("Hello from chat 1", 500);
    const ctx2 = createCtx("Hello from chat 2", 501);

    await handler.handleMessage(ctx1);
    await handler.handleMessage(ctx2);

    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
    expect(connectionMock.trpc.agent.prompt.mutate.mock.calls[0][0].text).toBe("Hello from chat 1");
    expect(connectionMock.trpc.agent.prompt.mutate.mock.calls[1][0].text).toBe("Hello from chat 2");
  });

  it("buffers independently per chat", async () => {
    const longA = "a".repeat(4100);
    const longB = "b".repeat(4100);

    const ctxA = createCtx(longA, 600);
    const ctxB = createCtx(longB, 601);

    await handler.handleMessage(ctxA);
    await handler.handleMessage(ctxB);

    // Neither should be processed immediately
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    await waitUntil(
      () => connectionMock.trpc.agent.prompt.mutate.mock.calls.length >= 2,
      2_000,
      "both buffers flushed",
    );

    // Both should have flushed independently
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
  });

  it("handles error when reply also fails", async () => {
    connectionMock.trpc.agent.prompt.mutate = vi.fn(async () => {
      throw new Error("Server down");
    });

    const origError = console.error;
    console.error = vi.fn(() => {});
    try {
      const ctx = createCtx("Hello", 700);
      ctx.reply = vi.fn(() => Promise.reject(new Error("Cannot reply")));

      // Should not throw even if both prompt and reply fail
      await handler.handleMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  it("ack reaction uses configured emoji", async () => {
    const customHandler = new MessageHandler({
      sessionMap: sessionMapMock,
      connection: connectionMock,
      renderer: rendererMock,
      approvalManager: approvalManagerMock,
      ackReaction: "thumbs_up",
      bufferTimeoutMs: 50,
    });

    const ctx = createCtx("Hello", 800);
    await customHandler.handleMessage(ctx);

    expect(apiMocks.setMessageReaction).toHaveBeenCalled();
    const reactionCall = apiMocks.setMessageReaction.mock.calls[0];
    expect(reactionCall[2][0].emoji).toBe("thumbs_up");

    customHandler.cleanup();
  });

  it("shows user-friendly message when agent is busy (CONFLICT)", async () => {
    const conflictError = new TRPCClientError("CONFLICT");
    (conflictError as any).data = { code: "CONFLICT" };
    connectionMock.trpc.agent.prompt.mutate = vi.fn(async () => {
      throw conflictError;
    });

    const origError = console.error;
    console.error = vi.fn(() => {});
    try {
      const ctx = createCtx("Hello");
      await handler.handleMessage(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const replyCall = ctx.reply.mock.calls[0];
      expect(replyCall[0]).toContain("wait for the current response");
    } finally {
      console.error = origError;
    }
  });

  it("handles missing message_id gracefully for reactions", async () => {
    const ctx = {
      chat: { id: 900, type: "private" },
      message: { text: "Hello", message_id: undefined },
      from: { id: 1234 },
      api: apiMocks,
      reply: vi.fn(() => Promise.resolve()),
    } as any;

    await handler.handleMessage(ctx);

    // Should not attempt reaction, but should still process message
    expect(apiMocks.setMessageReaction).not.toHaveBeenCalled();
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
  });
});
