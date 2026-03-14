import { describe, it, expect, beforeEach, vi } from "vitest";
import { ApprovalManager } from "../src/approval.js";

describe("ApprovalManager", () => {
  let approvalManager: InstanceType<typeof ApprovalManager>;
  let sendMessageSpy: ReturnType<typeof vi.fn>;
  let editMessageTextSpy: ReturnType<typeof vi.fn>;
  let answerCallbackQuerySpy: ReturnType<typeof vi.fn>;
  let approveSpy: ReturnType<typeof vi.fn>;
  let denySpy: ReturnType<typeof vi.fn>;
  let mockApi: any;
  let mockConnection: any;
  let mockDispatcher: any;
  let eventHandler: ((event: any) => void) | null;

  beforeEach(() => {
    sendMessageSpy = vi.fn(() =>
      Promise.resolve({ message_id: 99 }),
    );
    editMessageTextSpy = vi.fn(() => Promise.resolve(true));
    answerCallbackQuerySpy = vi.fn(() => Promise.resolve(true));
    approveSpy = vi.fn(() => Promise.resolve({ applied: true }));
    denySpy = vi.fn(() => Promise.resolve({ applied: true }));
    eventHandler = null;

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
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

  it("handles approve callback", async () => {
    // Start watching a session to register the event handler
    approvalManager.watchSession(100, "session-1");

    // Simulate tool_approval_required event
    await eventHandler!({
      type: "tool_approval_required",
      approvalId: "tc-1",
      toolName: "shell_exec",
      arguments: '{"command":"ls"}',
      sessionId: "session-1",
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    // Now handle the approve callback
    await approvalManager.handleCallback("cb-1", "tool_approve_tc-1");

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cb-1");
    expect(approveSpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-1",
      always: false,
    });
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("handles deny callback", async () => {
    approvalManager.watchSession(100, "session-1");

    await eventHandler!({
      type: "tool_approval_required",
      approvalId: "tc-2",
      toolName: "write_file",
      arguments: '{"path":"/tmp/test"}',
      sessionId: "session-1",
    });

    await approvalManager.handleCallback("cb-2", "tool_deny_tc-2");

    expect(denySpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "tc-2",
    });
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

    // Verify subscribe was called for each session
    expect(mockDispatcher.subscribe).toHaveBeenCalledTimes(2);
  });

  it("ignores non-approval events", async () => {
    approvalManager.watchSession(100, "session-1");

    // Should not throw or do anything for non-approval events
    await eventHandler!({ type: "content_delta", delta: "hello", content: "hello" });
    await eventHandler!({ type: "status_change", status: "idle" });

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
