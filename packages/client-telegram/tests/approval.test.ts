import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApprovalManager } from "../src/approval.js";

describe("ApprovalManager", () => {
  let approvalManager: InstanceType<typeof ApprovalManager>;
  let sendMessageSpy: ReturnType<typeof vi.fn>;
  let editMessageTextSpy: ReturnType<typeof vi.fn>;
  let editMessageReplyMarkupSpy: ReturnType<typeof vi.fn>;
  let answerCallbackQuerySpy: ReturnType<typeof vi.fn>;
  let approveSpy: ReturnType<typeof vi.fn>;
  let denySpy: ReturnType<typeof vi.fn>;
  let mockApi: any;
  let mockConnection: any;
  let mockDispatcher: any;
  let eventHandler: ((event: any) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();

    sendMessageSpy = vi.fn(() =>
      Promise.resolve({ message_id: 99 }),
    );
    editMessageTextSpy = vi.fn(() => Promise.resolve(true));
    editMessageReplyMarkupSpy = vi.fn(() => Promise.resolve(true));
    answerCallbackQuerySpy = vi.fn(() => Promise.resolve(true));
    approveSpy = vi.fn(() => Promise.resolve({ applied: true }));
    denySpy = vi.fn(() => Promise.resolve({ applied: true }));
    eventHandler = null;

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
      editMessageReplyMarkup: editMessageReplyMarkupSpy,
      answerCallbackQuery: answerCallbackQuerySpy,
    };

    mockConnection = {
      client: {
        tool: {
          approve: approveSpy,
          deny: denySpy,
        },
      },
    };

    mockDispatcher = {
      subscribe: vi.fn((_sessionId: string, onEvent: any) => {
        eventHandler = onEvent;
        return vi.fn(() => {});
      }),
      cleanup: vi.fn(() => {}),
    };

    approvalManager = new ApprovalManager({
      api: mockApi,
      connection: mockConnection,
      dispatcher: mockDispatcher,
    });
  });

  afterEach(() => {
    approvalManager.cleanup();
    vi.useRealTimers();
  });

  /** Helper: emit a tool_approval_required event for the given approvalId */
  async function emitApproval(approvalId: string, sessionId = "session-1") {
    await eventHandler!({
      type: "tool_approval_required",
      approvalId,
      toolName: "shell_exec",
      arguments: '{"command":"ls"}',
      sessionId,
    });
  }

  it("handles approve callback", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-1");

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    await approvalManager.handleCallback("cb-1", "tool_approve_tc-1");

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cb-1");
    expect(approveSpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-1",
      always: false,
    });
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("deny callback shows two-step keyboard (deny not called)", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-2");

    await approvalManager.handleCallback("cb-2", "tool_deny_tc-2");

    // Should NOT call deny yet — only show the two-step keyboard
    expect(denySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(
      100,
      99,
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ text: "Deny", callback_data: "tool_denynow_tc-2" }),
              expect.objectContaining({ text: "Deny with reason", callback_data: "tool_denyreason_tc-2" }),
            ]),
          ]),
        }),
      }),
    );
  });

  it("denynow callback denies without feedback", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-3");

    // First tap Deny to get two-step keyboard
    await approvalManager.handleCallback("cb-3a", "tool_deny_tc-3");
    // Then tap "Deny" (denynow)
    await approvalManager.handleCallback("cb-3b", "tool_denynow_tc-3");

    expect(denySpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-3",
    });
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      100,
      99,
      expect.stringContaining("Denied"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("denyreason callback sends ForceReply message", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-4");

    await approvalManager.handleCallback("cb-4a", "tool_deny_tc-4");
    await approvalManager.handleCallback("cb-4b", "tool_denyreason_tc-4");

    // Should send a ForceReply message
    expect(sendMessageSpy).toHaveBeenCalledWith(
      100,
      "Type your denial reason:",
      expect.objectContaining({
        reply_markup: { force_reply: true, selective: true },
      }),
    );

    // Should update original message to show awaiting state
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      100,
      99,
      expect.stringContaining("Awaiting denial reason"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );

    // deny should NOT have been called yet
    expect(denySpy).not.toHaveBeenCalled();
  });

  it("tryInterceptReply completes denial with feedback text", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-5");

    await approvalManager.handleCallback("cb-5a", "tool_deny_tc-5");
    await approvalManager.handleCallback("cb-5b", "tool_denyreason_tc-5");

    // The ForceReply message was sent with message_id 99
    const consumed = await approvalManager.tryInterceptReply(100, 99, "bad approach");

    expect(consumed).toBe(true);
    expect(denySpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-5",
      feedback: "bad approach",
    });
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      100,
      99,
      expect.stringContaining("Denied: bad approach"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("tryInterceptReply returns false for unrelated reply", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-6");

    // No feedback prompt active — reply to unrelated message
    const consumed = await approvalManager.tryInterceptReply(100, 555, "some text");
    expect(consumed).toBe(false);
    expect(denySpy).not.toHaveBeenCalled();
  });

  it("feedback timeout auto-denies without feedback", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-7");

    await approvalManager.handleCallback("cb-7a", "tool_deny_tc-7");
    await approvalManager.handleCallback("cb-7b", "tool_denyreason_tc-7");

    expect(denySpy).not.toHaveBeenCalled();

    // Advance time past the feedback timeout (5 minutes)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(denySpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-7",
    });
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      100,
      99,
      expect.stringContaining("Denied (timed out)"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("cleanup clears pending feedback timers", async () => {
    approvalManager.watchSession(100, "session-1");
    await emitApproval("tc-8");

    await approvalManager.handleCallback("cb-8a", "tool_deny_tc-8");
    await approvalManager.handleCallback("cb-8b", "tool_denyreason_tc-8");

    // Cleanup should not throw and should clear timers
    approvalManager.cleanup();

    // Advancing timers should NOT trigger the timeout handler (no deny call)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(denySpy).not.toHaveBeenCalled();
  });

  it("ignores unrecognized callback data", async () => {
    await approvalManager.handleCallback("cb-3", "something_else");

    expect(approveSpy).not.toHaveBeenCalled();
    expect(denySpy).not.toHaveBeenCalled();
  });

  it("ignores callback for unknown tool call", async () => {
    await approvalManager.handleCallback("cb-4", "tool_approve_unknown");

    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("cleanup unsubscribes from all sessions", () => {
    approvalManager.watchSession(100, "session-1");
    approvalManager.watchSession(200, "session-2");

    approvalManager.cleanup();

    expect(mockDispatcher.subscribe).toHaveBeenCalledTimes(2);
  });

  it("ignores non-approval events", async () => {
    approvalManager.watchSession(100, "session-1");

    await eventHandler!({ type: "content_delta", delta: "hello", content: "hello" });
    await eventHandler!({ type: "status_change", status: "idle" });

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
