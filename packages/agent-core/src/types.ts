// Import types from protocol for local use + re-export (single source of truth)
import type {
  AgentStatus,
  ToolCall,
  SessionMessageBase,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
} from "@molf-ai/protocol";

export type {
  AgentStatus,
  ToolCall,
  SessionMessageBase,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
};

// --- Resolved attachment (actual bytes for LLM) ---

/** Resolved attachment with actual bytes — used for LLM calls */
export interface ResolvedAttachment {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

// --- Session messages ---

export interface SessionMessage extends SessionMessageBase {
  attachments?: ResolvedAttachment[];   // inlined image bytes (user AND tool messages)
}

// --- Agent events (discriminated union) ---
// Agent-core's events use Error objects and reference agent-core's SessionMessage.
// Protocol's events use string errors and reference protocol's SessionMessage.

export interface TurnCompleteEvent {
  type: "turn_complete";
  message: SessionMessage;
}

export interface AgentErrorEvent {
  type: "error";
  error: Error;
}

export type AgentEvent =
  | StatusChangeEvent
  | ContentDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | TurnCompleteEvent
  | AgentErrorEvent;

// --- Event handler type ---

export type AgentEventHandler = (event: AgentEvent) => void;
