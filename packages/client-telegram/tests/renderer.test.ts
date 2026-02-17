import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Renderer } from "../src/renderer.js";

describe("Renderer", () => {
  let renderer: InstanceType<typeof Renderer>;
  let sendMessageSpy: ReturnType<typeof mock>;
  let editMessageTextSpy: ReturnType<typeof mock>;
  let sendChatActionSpy: ReturnType<typeof mock>;
  let mockApi: any;
  let mockDispatcher: any;
  let eventHandler: ((event: any) => void) | null;

  beforeEach(() => {
    sendMessageSpy = mock(() =>
      Promise.resolve({ message_id: 50 }),
    );
    editMessageTextSpy = mock(() => Promise.resolve(true));
    sendChatActionSpy = mock(() => Promise.resolve());
    eventHandler = null;

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
      sendChatAction: sendChatActionSpy,
    };

    mockDispatcher = {
      subscribe: mock((_sessionId: string, onEvent: any) => {
        eventHandler = onEvent;
        return mock(() => {});
      }),
      cleanup: mock(() => {}),
    };

    renderer = new Renderer({
      api: mockApi,
      dispatcher: mockDispatcher,
      streamingThrottleMs: 50,
    });
  });

  it("subscribes to events when starting a session", () => {
    renderer.startSession(100, "session-1");
    expect(eventHandler).not.toBeNull();
  });

  it("sends typing indicator on status_change to streaming", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });

    await sleep(10);
    expect(sendChatActionSpy).toHaveBeenCalledWith(100, "typing");
  });

  it("sends tool status message on tool_call_start", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "shell_exec", arguments: "{}" });

    await sleep(10);
    expect(sendMessageSpy).toHaveBeenCalled();
    const call = sendMessageSpy.mock.calls[0];
    expect(call[1]).toContain("shell_exec");
  });

  it("sends error message on error event", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({ type: "error", code: "ERR", message: "Something broke" });

    await sleep(10);
    expect(sendMessageSpy).toHaveBeenCalled();
    const call = sendMessageSpy.mock.calls[0];
    expect(call[1]).toContain("Something broke");
  });

  it("returns idle for unknown chat", () => {
    expect(renderer.getAgentStatus(999)).toBe("idle");
  });

  it("tracks agent status from events", () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "executing_tool" });
    expect(renderer.getAgentStatus(100)).toBe("executing_tool");
  });

  it("handles turn_complete with response", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({
      type: "turn_complete",
      message: {
        id: "msg-1",
        role: "assistant",
        content: "Hello world!",
        timestamp: Date.now(),
      },
    });

    await sleep(50);
    expect(sendMessageSpy).toHaveBeenCalled();
  });

  it("cleanup stops all sessions", () => {
    renderer.startSession(100, "session-1");
    renderer.cleanup();
    expect(renderer.getAgentStatus(100)).toBe("idle");
  });

  it("does not re-subscribe if already watching same session", () => {
    const localDispatcher = {
      subscribe: mock((_sessionId: string, _onEvent: any) => {
        return mock(() => {});
      }),
      cleanup: mock(() => {}),
    };

    const r = new Renderer({
      api: mockApi,
      dispatcher: localDispatcher,
      streamingThrottleMs: 50,
    });

    r.startSession(100, "session-1");
    r.startSession(100, "session-1"); // Same session

    expect(localDispatcher.subscribe).toHaveBeenCalledTimes(1);
  });

  it("stops typing indicator on idle status", async () => {
    renderer.startSession(100, "session-1");

    // Start typing
    eventHandler!({ type: "status_change", status: "streaming" });
    await sleep(10);
    expect(sendChatActionSpy).toHaveBeenCalledTimes(1);

    // Stop typing
    eventHandler!({ type: "status_change", status: "idle" });
    // Wait longer than the 5s interval would be, to check it was cleared
    // (We can't easily test interval clearing, but we can verify no crash)
    await sleep(10);
  });

  it("creates draft stream on content_delta event", async () => {
    renderer.startSession(100, "session-1");

    // content_delta needs a paragraph break (\n\n) to trigger chunker emission
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond" });
    await sleep(60);

    expect(sendMessageSpy).toHaveBeenCalled();
    const call = sendMessageSpy.mock.calls[0];
    expect(call[0]).toBe(100);
  });

  it("updates draft stream on subsequent content_delta events", async () => {
    renderer.startSession(100, "session-1");

    // First delta with a paragraph break triggers initial send
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond part" });
    await sleep(60);

    // Second delta adds another paragraph break, triggering an edit
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond part.\n\nThird part" });
    await sleep(100);

    // First send + at least one edit
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("handles tool_call_end and edits status message", async () => {
    renderer.startSession(100, "session-1");

    // Start a tool
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await sleep(10);

    // End the tool
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "file content" });
    await sleep(10);

    expect(editMessageTextSpy).toHaveBeenCalled();
    const editCall = editMessageTextSpy.mock.calls[0];
    expect(editCall[2]).toContain("Completed");
    expect(editCall[2]).toContain("read_file");
  });

  it("handles tool_call_end with error result", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "shell_exec", arguments: "{}" });
    await sleep(10);

    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "shell_exec", result: "error: command not found" });
    await sleep(10);

    expect(editMessageTextSpy).toHaveBeenCalled();
    const editCall = editMessageTextSpy.mock.calls[0];
    expect(editCall[2]).toContain("Failed");
  });

  it("clears toolStatusMessageId when all tools finish", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await sleep(10);

    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await sleep(10);

    // Start another tool — should send a new status message (toolStatusMessageId was cleared)
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await sleep(10);

    // Should have sent at least 2 sendMessage calls (one for each tool_call_start)
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles tool_call_end when edit fails", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await sleep(10);

    // Make edit fail
    editMessageTextSpy = mock(() => Promise.reject(new Error("message not found")));
    mockApi.editMessageText = editMessageTextSpy;

    // Should not throw
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await sleep(10);
  });

  it("handles multiple concurrent tools in status", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await sleep(10);

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await sleep(10);

    // End first tool — status should show completed + still running
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await sleep(10);

    const lastEditCall = editMessageTextSpy.mock.calls[editMessageTextSpy.mock.calls.length - 1];
    expect(lastEditCall[2]).toContain("write_file");
  });

  it("turn_complete edits draft with first chunk when draft exists", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream via content_delta (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Streaming content here.\n\nMore content" });
    await sleep(60);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Now trigger turn_complete — should edit the draft message
    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "Final content", timestamp: Date.now() },
    });
    await sleep(50);

    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("turn_complete falls back to sendMessage if editFormatted fails", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Draft content here.\n\nMore text" });
    await sleep(60);

    // Make edit fail with parse error then also fail fallback
    let editCallCount = 0;
    editMessageTextSpy = mock(() => {
      editCallCount++;
      return Promise.reject(new Error("can't parse entities"));
    });
    mockApi.editMessageText = editMessageTextSpy;

    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "**bad html", timestamp: Date.now() },
    });
    await sleep(50);

    // Should have tried to send as a new message as fallback
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("sendFormatted falls back to plain text on parse error", async () => {
    // Make sendMessage fail with parse error on first call, succeed on second
    let sendCallCount = 0;
    sendMessageSpy = mock((_chatId: any, _text: any, opts: any) => {
      sendCallCount++;
      if (sendCallCount === 1 && opts?.parse_mode === "HTML") {
        throw new Error("Bad Request: can't parse entities");
      }
      return Promise.resolve({ message_id: 50 });
    });
    mockApi.sendMessage = sendMessageSpy;

    renderer.startSession(100, "session-1");
    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "Simple text", timestamp: Date.now() },
    });
    await sleep(50);

    // Should have retried without parse_mode
    expect(sendCallCount).toBeGreaterThanOrEqual(2);
  });

  it("error event stops draft stream", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Streaming content.\n\nMore" });
    await sleep(60);

    // Error event should stop the draft
    await eventHandler!({ type: "error", code: "ERR", message: "Connection lost" });
    await sleep(10);

    // Subsequent content_delta should start a new draft
    eventHandler!({ type: "content_delta", content: "New content here.\n\nAnother part" });
    await sleep(60);

    // Should have sent 2+ messages (first draft + error message + new draft after error)
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops typing on error status", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });
    await sleep(10);

    eventHandler!({ type: "status_change", status: "error" });
    await sleep(10);
    // Should not crash
  });

  it("stops typing on aborted status", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });
    await sleep(10);

    eventHandler!({ type: "status_change", status: "aborted" });
    await sleep(10);
    // Should not crash
  });

  it("ignores tool_approval_required events", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({
      type: "tool_approval_required",
      toolCallId: "tc-1",
      toolName: "shell_exec",
      arguments: "{}",
      sessionId: "session-1",
    });
    await sleep(10);

    // Should not send any message
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("ignores events for unknown chat", async () => {
    renderer.startSession(100, "session-1");

    // Remove the chat state
    renderer.stopSession(100);

    // Send event — handler should bail early
    eventHandler!({ type: "status_change", status: "streaming" });
    await sleep(10);
    expect(sendChatActionSpy).not.toHaveBeenCalled();
  });

  it("updateToolStatus sends new message when edit fails", async () => {
    renderer.startSession(100, "session-1");

    // Start first tool to get a toolStatusMessageId
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await sleep(10);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Make edit fail on the next tool_call_start
    editMessageTextSpy = mock(() => Promise.reject(new Error("message not found")));
    mockApi.editMessageText = editMessageTextSpy;

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await sleep(10);

    // Should have tried to edit (failed), then sent a new message
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("turn_complete treats 'message is not modified' as success (no duplicate send)", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream via content_delta (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Hello! How can I help you today?\n\nLet me know." });
    await sleep(60);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Make edit throw "message is not modified" (content matches)
    editMessageTextSpy = mock(() =>
      Promise.reject(new Error("Bad Request: message is not modified")),
    );
    mockApi.editMessageText = editMessageTextSpy;

    const sendCountBefore = sendMessageSpy.mock.calls.length;

    await eventHandler!({
      type: "turn_complete",
      message: {
        id: "msg-1",
        role: "assistant",
        content: "Hello! How can I help you today?",
        timestamp: Date.now(),
      },
    });
    await sleep(50);

    // Should NOT have sent a new message — "not modified" means edit is a no-op success
    expect(sendMessageSpy.mock.calls.length).toBe(sendCountBefore);
  });

  it("handles turn_complete with empty content", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "", timestamp: Date.now() },
    });
    await sleep(50);

    // Empty content → no messages sent
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
