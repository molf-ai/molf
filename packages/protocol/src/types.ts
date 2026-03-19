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
  reasoning?: string;
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

/** All concrete event variants (everything except the subagent wrapper). */
export type BaseAgentEvent =
  | StatusChangeEvent
  | ContentDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | TurnCompleteEvent
  | AgentErrorEvent
  | ToolApprovalRequiredEvent
  | ToolApprovalResolvedEvent
  | ContextCompactedEvent
  | MessageQueuedEvent;

/** Wraps any base event with subagent metadata for parent-session forwarding. */
export interface SubagentEvent {
  type: "subagent_event";
  agentType: string;
  sessionId: string;
  event: BaseAgentEvent;
}

export type AgentEvent = BaseAgentEvent | SubagentEvent;

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

export interface ToolApprovalResolvedEvent {
  type: "tool_approval_resolved";
  approvalId: string;
  outcome: "approved" | "denied" | "cancelled";
  sessionId: string;
}

export interface ContextCompactedEvent {
  type: "context_compacted";
  summaryMessageId: string;
}

/** Emitted when a message is queued because the agent is busy. */
export interface MessageQueuedEvent {
  type: "message_queued";
  messageId: string;
  queuePosition: number;  // 1-based position in the queue
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
  workspaceId: string;
  createdAt: number;
  lastActiveAt: number;
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
  agents: WorkerAgentInfo[];
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

// --- Agent types ---

/**
 * Compact permission config format (duplicated from server/approval for transport).
 * Keys are tool names (or "*" for catch-all).
 * Values are either a simple action or a map of pattern → action.
 */
export type CompactPermission = Record<
  string,
  "allow" | "deny" | "ask" | Record<string, "allow" | "deny" | "ask">
>;

export interface WorkerAgentInfo {
  name: string;
  description: string;
  content: string;                    // markdown body = system prompt suffix
  permission?: CompactPermission;     // transport format
  maxSteps?: number;
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
  abortSignal?: AbortSignal;
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
  data: File;
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

/**
 * Declares how a path argument should be resolved against the workdir.
 */
export interface PathArgConfig {
  /** Argument name (e.g., "path", "cwd"). */
  name: string;
  /** If true, defaults to workdir when the argument is absent. */
  defaultToWorkdir?: boolean;
}

/**
 * A tool definition that can be registered with the worker.
 */
export interface WorkerTool {
  name: string;
  description: string;
  inputSchema?: object;
  execute?: (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<ToolResultEnvelope>;
  /** Declares which arguments are file paths that should be resolved against workdir. */
  pathArgs?: PathArgConfig[];
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
  filename: string;
  mimeType: string;
  size: number;
}

export interface FetchUploadResult {
  file: File;
}

// --- Filesystem protocol ---

export interface FsReadRequest {
  requestId: string;
  outputId?: string;
  path?: string;
}

export interface FsReadResult {
  requestId: string;
  content: string | File;
  size: number;
  encoding: "utf-8" | "binary";
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

export interface WorkerRegistration extends ConnectionEntry {
  role: "worker";
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  agents: WorkerAgentInfo[];
  metadata?: WorkerMetadata;
}

export interface KnownWorker {
  id: string;
  name: string;
  online: boolean;
  connectedAt: number;
  lastSeenAt: number;
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  agents: WorkerAgentInfo[];
  metadata?: WorkerMetadata;
}

export interface ClientRegistration extends ConnectionEntry {
  role: "client";
}

export type Registration = WorkerRegistration | ClientRegistration;

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
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
}

// --- Workspace types ---

export interface WorkspaceConfig {
  model?: string;   // LLM model override ("provider/model" format). undefined = use server default
}

export interface Workspace {
  id: string;                      // crypto.randomUUID()
  name: string;                    // display name, unique per worker, renameable
  isDefault: boolean;              // exactly one per worker, cannot be deleted
  lastSessionId: string;           // most recently used session
  sessions: string[];              // all session UUIDs (ordered by creation, newest last)
  createdAt: number;
  config: WorkspaceConfig;
}

export type WorkspaceEvent =
  | { type: "session_created"; sessionId: string; sessionName: string }
  | { type: "config_changed"; config: WorkspaceConfig }
  | { type: "cron_fired"; jobId: string; jobName: string; targetSessionId: string; message?: string; error?: string };

// --- Cron types ---

export type CronSchedule =
  | { kind: "at"; at: number }
  | { kind: "every"; interval_ms: number; anchor_ms?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronPayload =
  | { kind: "agent_turn"; message: string };

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  workerId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  consecutiveErrors: number;
}

// --- Server config ---

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  model: ModelId;
  tls: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}
