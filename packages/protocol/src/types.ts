import type { ModelId } from "./model-id.js";

// --- JSON-safe value type ---

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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

/**
 * Shared base for session messages across packages.
 *
 * Two concrete SessionMessage types exist because attachment representations differ:
 * - Protocol's SessionMessage uses FileRef (persisted file paths for storage/wire)
 * - Agent-core's SessionMessage uses ResolvedAttachment (in-memory bytes for LLM calls)
 *
 * Translation between the two happens in AgentRunner.resolveSessionMessages()
 * (server package), which loads file data from the inline media cache.
 */
export interface SessionMessageBase {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
  synthetic?: boolean;  // injected by system (e.g. shell exec), not by LLM
  summary?: boolean;    // marks summary checkpoint messages
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  model?: ModelId;      // which model produced this message ("provider/model" combined format)
}

export interface SessionMessage extends SessionMessageBase {
  attachments?: FileRef[];
}

// --- Agent events (discriminated union) ---

export type AgentEvent =
  | StatusChangeEvent
  | ContentDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | TurnCompleteEvent
  | AgentErrorEvent
  | ToolApprovalRequiredEvent
  | ContextCompactedEvent;

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
  truncated?: boolean;
  outputId?: string;    // opaque ID for fs.read retrieval
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
  approvalId: string;
  toolName: string;
  arguments: string;
  sessionId: string;
}

export interface ContextCompactedEvent {
  type: "context_compacted";
  summaryMessageId: string;
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

// --- Config types (wire/persistence shape) ---

export interface BehaviorConfig {
  systemPrompt?: string;
  maxSteps: number;
  contextPruning?: boolean;
  temperature?: number;
}

// --- Session file structure (for persistence) ---

export interface SessionFile {
  sessionId: string;
  name: string;
  workerId: string;
  createdAt: number;
  lastActiveAt: number;
  config?: {
    behavior?: Partial<BehaviorConfig>;
    model?: string;
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

/** Known fields in worker metadata. Open for extension via index signature. */
export interface WorkerMetadata {
  workdir?: string;
  agentsDoc?: string;
  [key: string]: unknown;
}

export interface WorkerInfo {
  workerId: string;
  name: string;
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  connected: boolean;
  metadata?: WorkerMetadata;
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

// --- Tool Architecture v2 types ---

import type { ZodType } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodType;
}

export interface ToolHandlerContext {
  toolCallId: string;
  workdir?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolResultEnvelope>;

export interface ToolResultEnvelope {
  output: string;
  error?: string;
  meta?: ToolResultMetadata;
  attachments?: Attachment[];
}

export interface Attachment {
  mimeType: string;
  data: string;  // base64
  path: string;
  size: number;
}

export interface ToolResultMetadata {
  truncated?: boolean;
  outputId?: string;
  instructionFiles?: Array<{ path: string; content: string }>;
  exitCode?: number;
  outputPath?: string;
}

// --- Tool call request (server → worker) ---

export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Wire shape of the worker → server tool result (matches workerToolResultInput schema). */
export interface WireToolResult {
  toolCallId: string;
  output: string;
  error?: string;
  meta?: ToolResultMetadata;
  attachments?: Attachment[];
}

// --- Upload request (server → worker) ---

export interface UploadRequest {
  uploadId: string;
  data: string;        // base64
  filename: string;
  mimeType: string;
}

// --- Filesystem protocol ---

export interface FsReadRequest {
  requestId: string;
  outputId?: string;
  path?: string;
}

export interface FsReadResult {
  requestId: string;
  content: string;
  size: number;
  encoding: "utf-8" | "base64";
  error?: string;
}

// --- Tool approval ---

export interface ToolApprovalRequest {
  approvalId: string;
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

// --- Model info (exposed to clients) ---

export interface ModelInfo {
  id: ModelId;
  name: string;
  providerID: string;
  capabilities: {
    reasoning: boolean;
    toolcall: boolean;
    temperature: boolean;
  };
  cost: { input: number; output: number };
  limit: { context: number; output: number };
  status: string;
}

export interface ProviderListItem {
  id: string;
  name: string;
  modelCount: number;
}

// --- Server config ---

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  model: ModelId;
}
