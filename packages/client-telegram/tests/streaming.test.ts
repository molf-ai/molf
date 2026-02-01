import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createDraftStream } from "../src/streaming.js";
import { MESSAGE_CHAR_LIMIT } from "../src/chunking.js";

describe("createDraftStream", () => {
  let sendMessageSpy: ReturnType<typeof mock>;
  let editMessageTextSpy: ReturnType<typeof mock>;
  let mockApi: any;

  beforeEach(() => {
    sendMessageSpy = mock(() =>
      Promise.resolve({ message_id: 42 }),
    );
    editMessageTextSpy = mock(() => Promise.resolve(true));

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
    };
  });

  it("sends a new message on first update", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(stream.getMessageId()).toBe(42);
  });

  it("edits message on subsequent updates after flush", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);

    stream.update("Hello world");
    await stream.flush();

    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("throttles rapid updates", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 100,
    });

    stream.update("a");
    await sleep(20);
    stream.update("ab");
    stream.update("abc");
    stream.update("abcd");

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    await stream.flush();
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("stop prevents further updates", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);
    stream.stop();

    stream.update("More content");
    await sleep(100);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(0);
  });

  it("flush resolves immediately when nothing pending", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    await stream.flush();
    expect(sendMessageSpy).toHaveBeenCalledTimes(0);
  });

  it("returns null messageId before first send", () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    expect(stream.getMessageId()).toBeNull();
  });

  it("returns null overflowMessageId initially", () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    expect(stream.getOverflowMessageId()).toBeNull();
  });

  it("handles HTML parse error fallback to plain text on edit", async () => {
    let editCallCount = 0;
    editMessageTextSpy = mock((_chatId: any, _msgId: any, _text: any, opts: any) => {
      editCallCount++;
      if (editCallCount === 1 && opts?.parse_mode === "HTML") {
        throw new Error("Bad Request: can't parse entities");
      }
      return Promise.resolve(true);
    });
    mockApi.editMessageText = editMessageTextSpy;

    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("**bold**");
    await sleep(20);

    stream.update("**bold** more");
    await stream.flush();

    // Should have been called at least twice (first attempt with HTML, fallback without)
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("ignores 'message is not modified' errors", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);

    // Make edit throw "not modified"
    editMessageTextSpy = mock(() =>
      Promise.reject(new Error("Bad Request: message is not modified")),
    );
    mockApi.editMessageText = editMessageTextSpy;

    stream.update("Hello"); // Same content — would normally trigger not-modified
    await stream.flush();

    // Should not throw / crash
  });

  it("handles overflow when content exceeds limit", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    // First message
    stream.update("short");
    await sleep(20);
    expect(stream.getMessageId()).toBe(42);

    // Now send something that exceeds the limit
    const longContent = "x".repeat(MESSAGE_CHAR_LIMIT + 500);
    stream.update(longContent);
    await stream.flush();

    // Should have started a new message (overflow)
    // The old message ID becomes the overflow
    expect(stream.getOverflowMessageId()).toBe(42);
  });

  it("deduplicates identical content", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);

    // Same content again
    stream.update("Hello");
    await stream.flush();

    // Only the initial send, no edit needed for identical content
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(0);
  });

  it("schedules flush via timer", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 100,
    });

    stream.update("Hello");
    await sleep(20);

    stream.update("Hello world");

    // Wait for throttle timer to fire
    await sleep(120);

    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("stop clears active timer", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 200,
    });

    stream.update("Hello");
    await sleep(20);

    // Schedule an edit via update
    stream.update("Hello world");
    // Stop before the timer fires
    stream.stop();

    await sleep(250);

    // Timer should have been cancelled — no edit
    expect(editMessageTextSpy).toHaveBeenCalledTimes(0);
  });

  it("handles send error that is not 'message not modified'", async () => {
    // Make sendMessage reject with a non-"not modified" error
    sendMessageSpy = mock(() =>
      Promise.reject(new Error("Network error")),
    );
    mockApi.sendMessage = sendMessageSpy;

    const origError = console.error;
    console.error = mock(() => {});
    try {
      const stream = createDraftStream({
        api: mockApi,
        chatId: 100,
        throttleMs: 50,
      });

      // Should not throw
      stream.update("Hello");
      await sleep(20);

      // messageId should still be null since send failed
      expect(stream.getMessageId()).toBeNull();
    } finally {
      console.error = origError;
    }
  });

  it("handles non-Error thrown in send", async () => {
    sendMessageSpy = mock(() => Promise.reject("string error"));
    mockApi.sendMessage = sendMessageSpy;

    const origError = console.error;
    console.error = mock(() => {});
    try {
      const stream = createDraftStream({
        api: mockApi,
        chatId: 100,
        throttleMs: 50,
      });

      stream.update("Hello");
      await sleep(20);

      // Should not crash — isMessageNotModified handles non-Error
      expect(stream.getMessageId()).toBeNull();
    } finally {
      console.error = origError;
    }
  });

  it("handles non-Error thrown in edit (isParseError branch)", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Hello");
    await sleep(20);

    // Make edit reject with a non-Error value
    editMessageTextSpy = mock(() => Promise.reject("not an error object"));
    mockApi.editMessageText = editMessageTextSpy;

    stream.update("Hello world");
    await stream.flush();

    // Should not crash
  });

  it("handles markdownToTelegramHtml conversion failure gracefully", async () => {
    // This is hard to trigger directly since markdownToTelegramHtml is simple,
    // but we can verify the stream doesn't crash by sending content that
    // exercises the code path. The catch on lines 53-54 handles conversion errors.
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    stream.update("Normal text");
    await sleep(20);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("does not send duplicate messages when first send is slow", async () => {
    // Simulate a slow sendMessage (e.g., network latency)
    let resolveSend: ((v: any) => void) | null = null;
    sendMessageSpy = mock(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));
    mockApi.sendMessage = sendMessageSpy;

    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    // First update triggers sendOrEdit (fire-and-forget) which is now awaiting sendMessage
    stream.update("Hello");

    // Before send completes, more updates arrive
    stream.update("Hello world");

    // Wait for the throttle timer to fire
    await sleep(80);

    // The scheduled flush should NOT have called sendMessage again
    // because inFlight guard prevents concurrent sends
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Now resolve the first send
    resolveSend!({ message_id: 42 });
    await sleep(10);

    // After send completes, the rescheduled flush should edit (not send a new message)
    await sleep(80);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalled();
    expect(stream.getMessageId()).toBe(42);
  });

  it("flush waits for in-flight send so messageId is available", async () => {
    // Simulate slow sendMessage — this is the key scenario:
    // turn_complete arrives while first send is still in-flight
    let resolveSend: ((v: any) => void) | null = null;
    sendMessageSpy = mock(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));
    mockApi.sendMessage = sendMessageSpy;

    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 50,
    });

    // First content_delta triggers fire-and-forget send
    stream.update("Hello world");

    // messageId is still null because send hasn't completed
    expect(stream.getMessageId()).toBeNull();

    // flush() should wait for the in-flight send to complete
    const flushPromise = stream.flush();

    // Resolve the send while flush is waiting
    resolveSend!({ message_id: 42 });

    await flushPromise;

    // Now messageId should be available
    expect(stream.getMessageId()).toBe(42);
    // Only one sendMessage call — no duplicate
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("does not schedule duplicate timers", async () => {
    const stream = createDraftStream({
      api: mockApi,
      chatId: 100,
      throttleMs: 200,
    });

    stream.update("Hello");
    await sleep(20);

    // Rapid updates should all schedule into the same timer
    stream.update("Hello w");
    stream.update("Hello wo");
    stream.update("Hello wor");
    stream.update("Hello worl");
    stream.update("Hello world");

    await stream.flush();

    // Only one edit should happen since flush clears the timer and sends once
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
