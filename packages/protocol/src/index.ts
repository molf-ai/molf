// CLI utilities
export { parseCli, type CliConfig, type CliOption } from "./cli.js";

// Truncation utility
export {
  truncateOutput,
  TRUNCATION_MAX_LINES,
  TRUNCATION_MAX_BYTES,
  type TruncationResult,
} from "./truncation.js";

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
  // Shell exec
  agentShellExecInput,
  agentShellExecOutput,
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
  // Filesystem protocol
  fsReadInput,
  fsReadOutput,
  workerFsReadRequestSchema,
  workerFsReadResultInput,
  workerFsReadResultOutput,
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
  FsReadRequest,
  FsReadResult,
  ConnectionEntry,
  ServerConfig,
  // Tool Architecture v2
  ToolDefinition,
  ToolHandlerContext,
  ToolHandler,
  ToolResultEnvelope,
  ToolResultMetadata,
  ShellResult,
  Attachment,
  WireToolResult,
} from "./types.js";

// Helpers
export {
  MAX_ATTACHMENT_BYTES,
  errorMessage,
  lastMessagePreview,
} from "./helpers.js";

// Tool definitions
export {
  builtinToolDefinitions,
  readFileDefinition,
  readFileInputSchema,
  writeFileDefinition,
  writeFileInputSchema,
  editFileDefinition,
  editFileInputSchema,
  shellExecDefinition,
  shellExecInputSchema,
  globDefinition,
  globInputSchema,
  grepDefinition,
  grepInputSchema,
} from "./tool-definitions/index.js";
