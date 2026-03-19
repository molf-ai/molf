import type { ClientOptions } from "ws";
import type { AgentStatus, AgentEvent, BaseAgentEvent, ToolApprovalRequest } from "@molf-ai/protocol";
import type { ToolCallInfo, CompletedToolCallGroup, DisplayMessage } from "../types.js";

export interface SubagentState {
  agentType: string;
  sessionId: string;
  status: AgentStatus;
  streamingContent: string;
  activeToolCalls: ToolCallInfo[];
  completedToolCallCount: number;
  error?: string;
}

export interface UseServerOptions {
  url: string;
  token: string;
  sessionId?: string;
  workerId?: string;
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
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
  workspaceId: string | null;
  workspaceName: string | null;
  pendingApprovals: ToolApprovalRequest[];
  isShellRunning: boolean;
  currentModel: string | null;
  activeSubagents: Record<string, SubagentState>;
  cronNotification: { jobName: string; targetSessionId: string; error?: string } | null;
  reconnecting: boolean;
  needsProviderSetup: boolean;
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
    workspaceId: null,
    workspaceName: null,
    pendingApprovals: [],
    isShellRunning: false,
    currentModel: null,
    activeSubagents: {},
    cronNotification: null,
    reconnecting: false,
    needsProviderSetup: false,
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
        activeSubagents: {},
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

    case "tool_approval_resolved":
      return {
        ...prev,
        pendingApprovals: prev.pendingApprovals.filter(
          (a) => a.approvalId !== event.approvalId,
        ),
      };

    case "subagent_event":
      return handleSubagentEvent(prev, event.agentType, event.sessionId, event.event);

    default:
      return prev;
  }
}

function handleSubagentEvent(
  prev: UseServerState,
  agentType: string,
  sessionId: string,
  inner: BaseAgentEvent,
): UseServerState {
  const key = sessionId;
  const existing = prev.activeSubagents[key];

  // Extract approval_resolved from wrapper and remove from pendingApprovals
  if (inner.type === "tool_approval_resolved") {
    return {
      ...prev,
      pendingApprovals: prev.pendingApprovals.filter(
        (a) => a.approvalId !== inner.approvalId,
      ),
    };
  }

  // Extract approval from wrapper and add to pendingApprovals
  if (inner.type === "tool_approval_required") {
    const base: SubagentState = existing ?? {
      agentType,
      sessionId,
      status: "idle",
      streamingContent: "",
      activeToolCalls: [],
      completedToolCallCount: 0,
    };
    return {
      ...prev,
      activeSubagents: { ...prev.activeSubagents, [key]: base },
      pendingApprovals: [
        ...prev.pendingApprovals,
        {
          approvalId: inner.approvalId,
          toolName: inner.toolName,
          arguments: inner.arguments,
          sessionId: inner.sessionId,
        },
      ],
    };
  }

  const base: SubagentState = existing ?? {
    agentType,
    sessionId,
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCallCount: 0,
  };

  let updated: SubagentState;

  switch (inner.type) {
    case "status_change":
      updated = { ...base, status: inner.status };
      break;
    case "content_delta":
      updated = { ...base, streamingContent: inner.content };
      break;
    case "tool_call_start":
      updated = {
        ...base,
        activeToolCalls: [
          ...base.activeToolCalls,
          {
            toolCallId: inner.toolCallId,
            toolName: inner.toolName,
            arguments: inner.arguments,
          },
        ],
      };
      break;
    case "tool_call_end":
      updated = {
        ...base,
        activeToolCalls: base.activeToolCalls.filter(
          (tc) => tc.toolCallId !== inner.toolCallId,
        ),
        completedToolCallCount: base.completedToolCallCount + 1,
      };
      break;
    case "turn_complete":
      updated = {
        ...base,
        status: "idle",
        streamingContent: "",
        activeToolCalls: [],
      };
      break;
    case "error":
      updated = { ...base, error: inner.message };
      break;
    default:
      updated = base;
  }

  return {
    ...prev,
    activeSubagents: { ...prev.activeSubagents, [key]: updated },
  };
}

export function createResetState(
  connected: boolean,
  sessionId: string | null,
  workerId?: string | null,
  workerName?: string | null,
  workspaceId?: string | null,
  workspaceName?: string | null,
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
    workspaceId: workspaceId ?? null,
    workspaceName: workspaceName ?? null,
    pendingApprovals: [],
    isShellRunning: false,
    currentModel: null,
    activeSubagents: {},
    cronNotification: null,
    reconnecting: false,
    needsProviderSetup: false,
  };
}

export function applySessionLoaded(
  prev: UseServerState,
  sessionId: string,
  messages: DisplayMessage[],
  workerId?: string | null,
  workerName?: string | null,
  workspaceId?: string | null,
  workspaceName?: string | null,
): UseServerState {
  return {
    ...prev,
    connected: true,
    sessionId,
    messages,
    workerId: workerId ?? prev.workerId,
    workerName: workerName ?? prev.workerName,
    workspaceId: workspaceId ?? prev.workspaceId,
    workspaceName: workspaceName ?? prev.workspaceName,
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
