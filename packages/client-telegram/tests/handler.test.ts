import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { MessageHandler } from "../src/handler.js";

describe("MessageHandler", () => {
  let handler: MessageHandler;
  let sessionMapMock: any;
  let connectionMock: any;
  let rendererMock: any;
  let approvalManagerMock: any;
  let apiMocks: {
    sendChatAction: ReturnType<typeof mock>;
    setMessageReaction: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    sessionMapMock = {
      getOrCreate: mock(async () => "session-1"),
    };

    connectionMock = {
      trpc: {
        agent: {
          prompt: {
            mutate: mock(async () => ({ messageId: "msg-1" })),
          },
        },
      },
    };

    rendererMock = {
      startSession: mock(() => {}),
    };

    approvalManagerMock = {
      watchSession: mock(() => {}),
    };

    apiMocks = {
      sendChatAction: mock(() => Promise.resolve()),
      setMessageReaction: mock(() => Promise.resolve()),
    };

    handler = new MessageHandler({
      sessionMap: sessionMapMock,
      connection: connectionMock,
      renderer: rendererMock,
      approvalManager: approvalManagerMock,
      ackReaction: "eyes",
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
      reply: mock(() => Promise.resolve()),
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
    connectionMock.trpc.agent.prompt.mutate = mock(async () => {
      throw new Error("Server error");
    });

    const origError = console.error;
    console.error = mock(() => {});
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

    // Wait for buffer timeout (1.5s)
    await sleep(1600);

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
    await sleep(1600);

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
    // The 13th starts a new buffer or gets processed
    await sleep(1600);

    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
  });

  it("handles reaction API not available gracefully", async () => {
    apiMocks.setMessageReaction = mock(() =>
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

    // After cleanup, the buffer timeout shouldn't fire and cause errors
    await sleep(1600);
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
    // Wait a tick for the async processMessage
    await sleep(50);
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
    const call = connectionMock.trpc.agent.prompt.mutate.mock.calls[0];
    // Flushed text is the first message only (the overflow triggers flush of existing)
    expect(call[0].text).toBe(bigText);
  });

  it("buffer timeout resets on each new fragment", async () => {
    const part1 = "x".repeat(4100);
    const ctx1 = createCtx(part1, 400);
    await handler.handleMessage(ctx1);

    // Wait 1 second (less than 1.5s timeout)
    await sleep(1000);

    // Send another part — should reset the timer
    const part2 = "y".repeat(200);
    const ctx2 = createCtx(part2, 400);
    await handler.handleMessage(ctx2);

    // At 1.5s from first message, buffer should NOT have flushed yet
    // (timer was reset by part2)
    await sleep(600);
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();

    // Wait for the reset timer to expire
    await sleep(1000);
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

    await sleep(1600);

    // Both should have flushed independently
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
  });

  it("handles error when reply also fails", async () => {
    connectionMock.trpc.agent.prompt.mutate = mock(async () => {
      throw new Error("Server down");
    });

    const origError = console.error;
    console.error = mock(() => {});
    try {
      const ctx = createCtx("Hello", 700);
      ctx.reply = mock(() => Promise.reject(new Error("Cannot reply")));

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
    connectionMock.trpc.agent.prompt.mutate = mock(async () => {
      throw conflictError;
    });

    const origError = console.error;
    console.error = mock(() => {});
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
      reply: mock(() => Promise.resolve()),
    } as any;

    await handler.handleMessage(ctx);

    // Should not attempt reaction, but should still process message
    expect(apiMocks.setMessageReaction).not.toHaveBeenCalled();
    expect(connectionMock.trpc.agent.prompt.mutate).toHaveBeenCalled();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
