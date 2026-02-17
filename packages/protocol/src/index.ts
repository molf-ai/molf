// CLI utilities
export { parseCli, type CliConfig, type CliOption } from "./cli.js";

// Zod schemas
export {
  // JSON value
  jsonValueSchema,
  // Session
  sessionCreateInput,
  sessionCreateOutput,
  sessionListInput,
  sessionListOutput,
  sessionLoadInput,
  sessionLoadOutput,
  sessionDeleteInput,
  sessionDeleteOutput,
  sessionRenameInput,
  sessionRenameOutput,
  sessionMessageSchema,
  // Media / Files
  fileRefSchema,
  fileRefInputSchema,
  // Agent
  agentListOutput,
  agentPromptInput,
  agentPromptOutput,
  agentAbortInput,
  agentAbortOutput,
  agentStatusInput,
  agentStatusOutput,
  agentOnEventsInput,
  agentEventSchema,
  // Upload
  agentUploadInput,
  agentUploadOutput,
  // Tool
  toolListInput,
  toolListOutput,
  toolApproveInput,
  toolApproveOutput,
  toolDenyInput,
  toolDenyOutput,
  // Worker
  workerRegisterInput,
  workerRegisterOutput,
  workerRenameInput,
  workerRenameOutput,
  workerIdInput,
  workerToolCallSchema,
  workerToolResultInput,
  workerToolResultOutput,
  // Worker upload
  workerUploadRequestSchema,
  workerUploadResultInput,
  workerUploadResultOutput,
} from "./schemas.js";

// Shared types
export type {
  JsonValue,
  LLMConfig,
  BehaviorConfig,
  AgentStatus,
  AgentEvent,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  TurnCompleteEvent,
  AgentErrorEvent,
  ToolApprovalRequiredEvent,
  SessionMessageBase,
  SessionMessage,
  ToolCall,
  FileRef,
  BinaryResult,
  UploadRequest,
  ServerError,
  SessionFile,
  SessionListItem,
  WorkerInfo,
  WorkerMetadata,
  WorkerToolInfo,
  WorkerSkillInfo,
  ToolCallRequest,
  ToolApprovalRequest,
  ConnectionEntry,
  ServerConfig,
} from "./types.js";

// Helpers
export {
  MAX_ATTACHMENT_BYTES,
  errorMessage,
  lastMessagePreview,
} from "./helpers.js";

// Type guards
export { isBinaryResult } from "./types.js";
