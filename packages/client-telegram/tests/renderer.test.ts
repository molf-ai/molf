import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitUntil, flushAsync } from "@molf-ai/test-utils";
import { Renderer } from "../src/renderer.js";

describe("Renderer", () => {
  let renderer: InstanceType<typeof Renderer>;
  let sendMessageSpy: ReturnType<typeof vi.fn>;
  let editMessageTextSpy: ReturnType<typeof vi.fn>;
  let sendChatActionSpy: ReturnType<typeof vi.fn>;
  let mockApi: any;
  let mockDispatcher: any;
  let eventHandler: ((event: any) => void) | null;

  beforeEach(() => {
    sendMessageSpy = vi.fn(() =>
      Promise.resolve({ message_id: 50 }),
    );
    editMessageTextSpy = vi.fn(() => Promise.resolve(true));
    sendChatActionSpy = vi.fn(() => Promise.resolve());
    eventHandler = null;

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
      sendChatAction: sendChatActionSpy,
    };

    mockDispatcher = {
      subscribe: vi.fn((_sessionId: string, onEvent: any) => {
        eventHandler = onEvent;
        return vi.fn(() => {});
      }),
      cleanup: vi.fn(() => {}),
    };

    renderer = new Renderer({
      api: mockApi,
      dispatcher: mockDispatcher,
      streamingThrottleMs: 0,
    });
  });

  /** Wait for N sendMessage calls. */
  const waitForSend = (n = 1) =>
    waitUntil(() => sendMessageSpy.mock.calls.length >= n, 2_000, `${n} send(s)`);

  /** Wait for N editMessageText calls. */
  const waitForEdit = (n = 1) =>
    waitUntil(() => editMessageTextSpy.mock.calls.length >= n, 2_000, `${n} edit(s)`);

  it("subscribes to events when starting a session", () => {
    renderer.startSession(100, "session-1");
    expect(eventHandler).not.toBeNull();
  });

  it("sends typing indicator on status_change to streaming", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });

    await waitUntil(() => sendChatActionSpy.mock.calls.length >= 1, 2_000, "typing indicator");
    expect(sendChatActionSpy).toHaveBeenCalledWith(100, "typing");
  });

  it("sends tool status message on tool_call_start", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "shell_exec", arguments: "{}" });

    await waitForSend();
    expect(sendMessageSpy).toHaveBeenCalled();
    const call = sendMessageSpy.mock.calls[0];
    expect(call[1]).toContain("shell_exec");
  });

  it("sends error message on error event", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({ type: "error", code: "ERR", message: "Something broke" });

    await waitForSend();
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

    await waitForSend();
    expect(sendMessageSpy).toHaveBeenCalled();
  });

  it("cleanup stops all sessions", () => {
    renderer.startSession(100, "session-1");
    renderer.cleanup();
    expect(renderer.getAgentStatus(100)).toBe("idle");
  });

  it("does not re-subscribe if already watching same session", () => {
    const localDispatcher = {
      subscribe: vi.fn((_sessionId: string, _onEvent: any) => {
        return vi.fn(() => {});
      }),
      cleanup: vi.fn(() => {}),
    };

    const r = new Renderer({
      api: mockApi,
      dispatcher: localDispatcher,
      streamingThrottleMs: 0,
    });

    r.startSession(100, "session-1");
    r.startSession(100, "session-1"); // Same session

    expect(localDispatcher.subscribe).toHaveBeenCalledTimes(1);
  });

  it("stops typing indicator on idle status", async () => {
    renderer.startSession(100, "session-1");

    // Start typing
    eventHandler!({ type: "status_change", status: "streaming" });
    await waitUntil(() => sendChatActionSpy.mock.calls.length >= 1, 2_000, "typing indicator");
    expect(sendChatActionSpy).toHaveBeenCalledTimes(1);

    // Stop typing
    eventHandler!({ type: "status_change", status: "idle" });
    await flushAsync();
  });

  it("creates draft stream on content_delta event", async () => {
    renderer.startSession(100, "session-1");

    // content_delta needs a paragraph break (\n\n) to trigger chunker emission
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond" });
    await waitForSend();

    expect(sendMessageSpy).toHaveBeenCalled();
    const call = sendMessageSpy.mock.calls[0];
    expect(call[0]).toBe(100);
  });

  it("updates draft stream on subsequent content_delta events", async () => {
    renderer.startSession(100, "session-1");

    // First delta with a paragraph break triggers initial send
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond part" });
    await waitForSend();

    // Second delta adds another paragraph break, triggering an edit
    eventHandler!({ type: "content_delta", content: "First paragraph.\n\nSecond part.\n\nThird part" });
    await waitForEdit();

    // First send + at least one edit
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("handles tool_call_end and edits status message", async () => {
    renderer.startSession(100, "session-1");

    // Start a tool
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await waitForSend();

    // End the tool
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "file content" });
    await waitForEdit();

    expect(editMessageTextSpy).toHaveBeenCalled();
    const editCall = editMessageTextSpy.mock.calls[0];
    expect(editCall[2]).toContain("Completed");
    expect(editCall[2]).toContain("read_file");
  });

  it("handles tool_call_end with error result", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "shell_exec", arguments: "{}" });
    await waitForSend();

    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "shell_exec", result: "error: command not found" });
    await waitForEdit();

    expect(editMessageTextSpy).toHaveBeenCalled();
    const editCall = editMessageTextSpy.mock.calls[0];
    expect(editCall[2]).toContain("Failed");
  });

  it("clears toolStatusMessageId when all tools finish", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await waitForSend();

    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await waitForEdit();

    // Start another tool — should send a new status message (toolStatusMessageId was cleared)
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await waitForSend(2);

    // Should have sent at least 2 sendMessage calls (one for each tool_call_start)
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles tool_call_end when edit fails", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await waitForSend();

    // Make edit fail
    editMessageTextSpy = vi.fn(() => Promise.reject(new Error("message not found")));
    mockApi.editMessageText = editMessageTextSpy;

    // Should not throw
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await flushAsync();
  });

  it("handles multiple concurrent tools in status", async () => {
    renderer.startSession(100, "session-1");

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await waitForSend();

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await waitForEdit();

    // End first tool — status should show completed + still running
    await eventHandler!({ type: "tool_call_end", toolCallId: "tc-1", toolName: "read_file", result: "ok" });
    await waitForEdit(2);

    const lastEditCall = editMessageTextSpy.mock.calls[editMessageTextSpy.mock.calls.length - 1];
    expect(lastEditCall[2]).toContain("write_file");
  });

  it("turn_complete edits draft with first chunk when draft exists", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream via content_delta (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Streaming content here.\n\nMore content" });
    await waitForSend();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Now trigger turn_complete — should edit the draft message
    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "Final content", timestamp: Date.now() },
    });
    await waitForEdit();

    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("turn_complete falls back to sendMessage if editFormatted fails", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Draft content here.\n\nMore text" });
    await waitForSend();

    // Make edit fail with parse error then also fail fallback
    let editCallCount = 0;
    editMessageTextSpy = vi.fn(() => {
      editCallCount++;
      return Promise.reject(new Error("can't parse entities"));
    });
    mockApi.editMessageText = editMessageTextSpy;

    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "**bad html", timestamp: Date.now() },
    });
    await waitForSend(2);

    // Should have tried to send as a new message as fallback
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("sendFormatted falls back to plain text on parse error", async () => {
    // Make sendMessage fail with parse error on first call, succeed on second
    let sendCallCount = 0;
    sendMessageSpy = vi.fn((_chatId: any, _text: any, opts: any) => {
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
    await waitUntil(() => sendCallCount >= 2, 2_000, "sendFormatted fallback");

    // Should have retried without parse_mode
    expect(sendCallCount).toBeGreaterThanOrEqual(2);
  });

  it("error event stops draft stream", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Streaming content.\n\nMore" });
    await waitForSend();

    // Error event should stop the draft
    await eventHandler!({ type: "error", code: "ERR", message: "Connection lost" });
    await waitForSend(2); // error message is the second send

    // Subsequent content_delta should start a new draft
    eventHandler!({ type: "content_delta", content: "New content here.\n\nAnother part" });
    await waitForSend(3);

    // Should have sent 3 messages (first draft + error message + new draft after error)
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops typing on error status", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });
    await waitUntil(() => sendChatActionSpy.mock.calls.length >= 1, 2_000, "typing");

    eventHandler!({ type: "status_change", status: "error" });
    await flushAsync();
    // Should not crash
  });

  it("stops typing on aborted status", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });
    await waitUntil(() => sendChatActionSpy.mock.calls.length >= 1, 2_000, "typing");

    eventHandler!({ type: "status_change", status: "aborted" });
    await flushAsync();
    // Should not crash
  });

  it("ignores subagent_event (passthrough — no rendering)", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
      event: { type: "status_change", status: "streaming" },
    });
    await flushAsync();

    // No messages should be sent for subagent events
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(sendChatActionSpy).not.toHaveBeenCalled();
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
    await flushAsync();

    // Should not send any message
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("typing indicator includes 5-minute safety limit", async () => {
    renderer.startSession(100, "session-1");
    eventHandler!({ type: "status_change", status: "streaming" });
    await waitUntil(() => sendChatActionSpy.mock.calls.length >= 1, 2_000, "typing");

    expect(sendChatActionSpy).toHaveBeenCalledWith(100, "typing");

    // Verify the typing indicator is running (re-entry guard)
    eventHandler!({ type: "status_change", status: "streaming" });
    await flushAsync();
    // Only 1 call — guard prevents duplicate interval
    expect(sendChatActionSpy).toHaveBeenCalledTimes(1);

    // Cleanup stops the interval
    renderer.stopSession(100);
    const callCount = sendChatActionSpy.mock.calls.length;
    await flushAsync();
    expect(sendChatActionSpy.mock.calls.length).toBe(callCount);
  });

  it("ignores events for unknown chat", async () => {
    renderer.startSession(100, "session-1");

    // Remove the chat state
    renderer.stopSession(100);

    // Send event — handler should bail early
    eventHandler!({ type: "status_change", status: "streaming" });
    await flushAsync();
    expect(sendChatActionSpy).not.toHaveBeenCalled();
  });

  it("updateToolStatus sends new message when edit fails", async () => {
    renderer.startSession(100, "session-1");

    // Start first tool to get a toolStatusMessageId
    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" });
    await waitForSend();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Make edit fail on the next tool_call_start
    editMessageTextSpy = vi.fn(() => Promise.reject(new Error("message not found")));
    mockApi.editMessageText = editMessageTextSpy;

    await eventHandler!({ type: "tool_call_start", toolCallId: "tc-2", toolName: "write_file", arguments: "{}" });
    await waitForSend(2);

    // Should have tried to edit (failed), then sent a new message
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("turn_complete treats 'message is not modified' as success (no duplicate send)", async () => {
    renderer.startSession(100, "session-1");

    // Create a draft stream via content_delta (needs paragraph break to emit)
    eventHandler!({ type: "content_delta", content: "Hello! How can I help you today?\n\nLet me know." });
    await waitForSend();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Make edit throw "message is not modified" (content matches)
    editMessageTextSpy = vi.fn(() =>
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
    await flushAsync();

    // Should NOT have sent a new message — "not modified" means edit is a no-op success
    expect(sendMessageSpy.mock.calls.length).toBe(sendCountBefore);
  });

  it("handles turn_complete with empty content", async () => {
    renderer.startSession(100, "session-1");
    await eventHandler!({
      type: "turn_complete",
      message: { id: "msg-1", role: "assistant", content: "", timestamp: Date.now() },
    });
    await flushAsync();

    // Empty content → no messages sent
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
