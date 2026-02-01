import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ApprovalManager } from "../src/approval.js";

describe("ApprovalManager", () => {
  let approvalManager: InstanceType<typeof ApprovalManager>;
  let sendMessageSpy: ReturnType<typeof mock>;
  let editMessageTextSpy: ReturnType<typeof mock>;
  let answerCallbackQuerySpy: ReturnType<typeof mock>;
  let approveSpy: ReturnType<typeof mock>;
  let denySpy: ReturnType<typeof mock>;
  let mockApi: any;
  let mockConnection: any;

  beforeEach(() => {
    sendMessageSpy = mock(() =>
      Promise.resolve({ message_id: 99 }),
    );
    editMessageTextSpy = mock(() => Promise.resolve(true));
    answerCallbackQuerySpy = mock(() => Promise.resolve(true));
    approveSpy = mock(() => Promise.resolve({ applied: true }));
    denySpy = mock(() => Promise.resolve({ applied: true }));

    mockApi = {
      sendMessage: sendMessageSpy,
      editMessageText: editMessageTextSpy,
      answerCallbackQuery: answerCallbackQuerySpy,
    };

    mockConnection = {
      trpc: {
        agent: {
          onEvents: {
            subscribe: mock((_input: any, _opts: any) => ({
              unsubscribe: mock(() => {}),
            })),
          },
        },
        tool: {
          approve: { mutate: approveSpy },
          deny: { mutate: denySpy },
        },
      },
    };

    approvalManager = new ApprovalManager({
      api: mockApi,
      connection: mockConnection,
    });
  });

  it("handles approve callback", async () => {
    // Start watching a session to register the event handler
    approvalManager.watchSession(100, "session-1");

    const subscribeCall = mockConnection.trpc.agent.onEvents.subscribe.mock.calls[0];
    const onData = subscribeCall[1].onData;

    // Simulate tool_approval_required event
    await onData({
      type: "tool_approval_required",
      toolCallId: "tc-1",
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
      toolCallId: "tc-1",
    });
    expect(editMessageTextSpy).toHaveBeenCalled();
  });

  it("handles deny callback", async () => {
    approvalManager.watchSession(100, "session-1");

    const subscribeCall = mockConnection.trpc.agent.onEvents.subscribe.mock.calls[0];
    const onData = subscribeCall[1].onData;

    await onData({
      type: "tool_approval_required",
      toolCallId: "tc-2",
      toolName: "write_file",
      arguments: '{"path":"/tmp/test"}',
      sessionId: "session-1",
    });

    await approvalManager.handleCallback("cb-2", "tool_deny_tc-2");

    expect(denySpy).toHaveBeenCalledWith({
      sessionId: "session-1",
      toolCallId: "tc-2",
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

    // Verify unsubscribe was called for each session
    const subscribeCalls = mockConnection.trpc.agent.onEvents.subscribe.mock.calls;
    expect(subscribeCalls.length).toBe(2);
  });

  it("ignores non-approval events", async () => {
    approvalManager.watchSession(100, "session-1");

    const subscribeCall = mockConnection.trpc.agent.onEvents.subscribe.mock.calls[0];
    const onData = subscribeCall[1].onData;

    // Should not throw or do anything for non-approval events
    await onData({ type: "content_delta", delta: "hello", content: "hello" });
    await onData({ type: "status_change", status: "idle" });

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
