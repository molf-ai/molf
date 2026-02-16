// --- Agent lifecycle statuses ---

export type AgentStatus =
  | "idle"
  | "streaming"
  | "executing_tool"
  | "error"
  | "aborted";

// --- Tool call format (unified across agent-core and protocol) ---

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  providerMetadata?: Record<string, Record<string, unknown>>;
}

// --- Resolved attachment (actual bytes for LLM) ---

/** Resolved attachment with actual bytes — used for LLM calls */
export interface ResolvedAttachment {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

// --- Session messages ---

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: ResolvedAttachment[];   // inlined image bytes (user AND tool messages)
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}

// --- Agent events (discriminated union) ---

export type AgentEvent =
  | StatusChangeEvent
  | ContentDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | TurnCompleteEvent
  | AgentErrorEvent;

export interface StatusChangeEvent {
  type: "status_change";
  status: AgentStatus;
}

export interface ContentDeltaEvent {
  type: "content_delta";
  delta: string;
  content: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  toolCallId: string;
  toolName: string;
  arguments: string;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  toolCallId: string;
  toolName: string;
  result: string;
}

export interface TurnCompleteEvent {
  type: "turn_complete";
  message: SessionMessage;
}

export interface AgentErrorEvent {
  type: "error";
  error: Error;
}

// --- Event handler type ---

export type AgentEventHandler = (event: AgentEvent) => void;
