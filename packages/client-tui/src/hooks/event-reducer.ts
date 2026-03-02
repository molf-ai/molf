import type { AgentStatus, AgentEvent, ToolApprovalRequest } from "@molf-ai/protocol";
import type { ToolCallInfo, CompletedToolCallGroup, DisplayMessage } from "../types.js";

export interface UseServerOptions {
  url: string;
  token: string;
  sessionId?: string;
  workerId?: string;
}

export interface UseServerState {
  messages: DisplayMessage[];
  status: AgentStatus;
  streamingContent: string;
  activeToolCalls: ToolCallInfo[];
  completedToolCalls: CompletedToolCallGroup[];
  error: Error | null;
  connected: boolean;
  sessionId: string | null;
  workerId: string | null;
  workerName: string | null;
  pendingApprovals: ToolApprovalRequest[];
  isShellRunning: boolean;
  currentModel: string | null;
}

export function createInitialState(opts: { sessionId?: string; workerId?: string }): UseServerState {
  return {
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
    connected: false,
    sessionId: opts.sessionId ?? null,
    workerId: opts.workerId ?? null,
    workerName: null,
    pendingApprovals: [],
    isShellRunning: false,
    currentModel: null,
  };
}

export function handleEvent(
  prev: UseServerState,
  event: AgentEvent,
): UseServerState {
  switch (event.type) {
    case "status_change":
      return {
        ...prev,
        status: event.status,
        ...(event.status === "idle" ? { streamingContent: "" } : {}),
      };

    case "content_delta":
      return {
        ...prev,
        streamingContent: event.content,
      };

    case "tool_call_start":
      return {
        ...prev,
        activeToolCalls: [
          ...prev.activeToolCalls,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.arguments,
          },
        ],
      };

    case "tool_call_end":
      return {
        ...prev,
        activeToolCalls: prev.activeToolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId
            ? { ...tc, result: event.result }
            : tc,
        ),
      };

    case "turn_complete":
      return {
        ...prev,
        messages: [...prev.messages, event.message as DisplayMessage],
        streamingContent: "",
        activeToolCalls: [],
        completedToolCalls:
          prev.activeToolCalls.length > 0
            ? [
                ...prev.completedToolCalls,
                {
                  assistantMessageId: event.message.id,
                  toolCalls: [...prev.activeToolCalls],
                },
              ]
            : prev.completedToolCalls,
      };

    case "error":
      return {
        ...prev,
        error: new Error(event.message),
      };

    case "tool_approval_required":
      return {
        ...prev,
        pendingApprovals: [
          ...prev.pendingApprovals,
          {
            approvalId: event.approvalId,
            toolName: event.toolName,
            arguments: event.arguments,
            sessionId: event.sessionId,
          },
        ],
      };

    default:
      return prev;
  }
}

export function createResetState(
  connected: boolean,
  sessionId: string | null,
  workerId?: string | null,
  workerName?: string | null,
): UseServerState {
  return {
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
    connected,
    sessionId,
    workerId: workerId ?? null,
    workerName: workerName ?? null,
    pendingApprovals: [],
    isShellRunning: false,
    currentModel: null,
  };
}

export function applySessionLoaded(
  prev: UseServerState,
  sessionId: string,
  messages: DisplayMessage[],
  workerId?: string | null,
  workerName?: string | null,
): UseServerState {
  return {
    ...prev,
    connected: true,
    sessionId,
    messages,
    workerId: workerId ?? prev.workerId,
    workerName: workerName ?? prev.workerName,
  };
}

export function removeApproval(
  prev: UseServerState,
  approvalId: string,
): UseServerState {
  return {
    ...prev,
    pendingApprovals: prev.pendingApprovals.filter(
      (a) => a.approvalId !== approvalId,
    ),
  };
}
