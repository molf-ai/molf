// --- Agent lifecycle statuses ---

export type AgentStatus =
  | "idle"
  | "streaming"
  | "executing_tool"
  | "error"
  | "aborted";

// --- Session messages ---

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  providerMetadata?: Record<string, Record<string, unknown>>;
}

/** Stored in SessionMessage — references uploaded file on worker.
 *  Single source of truth, imported by all packages. */
export interface FileRef {
  path: string;           // relative to workdir: .molf/uploads/{uuid}-{name}
  mimeType: string;
  filename?: string;      // original filename (before UUID prefix)
  size?: number;          // bytes
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: FileRef[];
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
  | AgentErrorEvent
  | ToolApprovalRequiredEvent;

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
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface ToolApprovalRequiredEvent {
  type: "tool_approval_required";
  toolCallId: string;
  toolName: string;
  arguments: string;
  sessionId: string;
}

// --- Server error structure ---

export interface ServerError {
  code: string;
  message: string;
  context?: {
    sessionId?: string;
    toolName?: string;
    workerId?: string;
    [key: string]: unknown;
  };
}

// --- Session file structure (for persistence) ---

export interface SessionFile {
  sessionId: string;
  name: string;
  workerId: string;
  createdAt: number;
  lastActiveAt: number;
  config?: {
    llm?: Record<string, unknown>;
    behavior?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
  messages: SessionMessage[];
}

export interface SessionListItem {
  sessionId: string;
  name: string;
  workerId: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  active: boolean;
  lastMessage?: string;
  metadata?: Record<string, unknown>;
}

// --- Worker info ---

export interface WorkerInfo {
  workerId: string;
  name: string;
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  connected: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkerToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WorkerSkillInfo {
  name: string;
  description: string;
  content: string;
}

// --- Tool call request (server → worker) ---

export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// --- Binary tool result (e.g. read_file on an image/PDF/audio) ---

/** Binary tool result. Flows as `result: unknown` through the wire,
 *  interpreted at the destination via isBinaryResult() and toModelOutput. */
export interface BinaryResult {
  type: "binary";
  data: string;        // base64
  mimeType: string;
  path: string;
  size: number;
}

export function isBinaryResult(v: unknown): v is BinaryResult {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as any).type === "binary" &&
    typeof (v as any).data === "string" &&
    typeof (v as any).mimeType === "string"
  );
}

// --- Upload request (server → worker) ---

export interface UploadRequest {
  uploadId: string;
  data: string;        // base64
  filename: string;
  mimeType: string;
}

// --- Tool approval ---

export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  arguments: string;
  sessionId: string;
}

// --- Connection info ---

export interface ConnectionEntry {
  role: "worker" | "client";
  id: string;
  name: string;
  connectedAt: number;
}

// --- Server config ---

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  llm: {
    provider: string;
    model: string;
  };
}
