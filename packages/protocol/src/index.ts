// Model ID helpers
export type { ModelId, ModelRef } from "./model-id.js";
export { parseModelId, formatModelId } from "./model-id.js";

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
  baseAgentEventSchema,
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
  workerSyncStateInput,
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
  // Workspace
  workspaceConfigSchema,
  workspaceSchema,
  workspaceEventSchema,
  workspaceListInput,
  workspaceListOutput,
  workspaceCreateInput,
  workspaceCreateOutput,
  workspaceRenameInput,
  workspaceRenameOutput,
  workspaceSetConfigInput,
  workspaceSetConfigOutput,
  workspaceSessionsInput,
  workspaceSessionsOutput,
  workspaceEnsureDefaultInput,
  workspaceEnsureDefaultOutput,
  workspaceOnEventsInput,
  // Cron
  cronScheduleSchema,
  cronPayloadSchema,
  cronJobSchema,
  cronAddInput,
  cronListInput,
  cronRemoveInput,
  cronUpdateInput,
} from "./schemas.js";

// Shared types
export type {
  JsonValue,
  BehaviorConfig,
  AgentStatus,
  AgentEvent,
  BaseAgentEvent,
  SubagentEvent,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  TurnCompleteEvent,
  AgentErrorEvent,
  ToolApprovalRequiredEvent,
  ContextCompactedEvent,
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
  CompactPermission,
  WorkerAgentInfo,
  ToolCallRequest,
  ToolApprovalRequest,
  FsReadRequest,
  FsReadResult,
  ConnectionEntry,
  ServerConfig,
  ModelInfo,
  ProviderListItem,
  // Workspace
  WorkspaceConfig,
  Workspace,
  WorkspaceEvent,
  // Cron
  CronJob,
  CronSchedule,
  CronPayload,
  // Tool Architecture v2
  ToolDefinition,
  ToolHandlerContext,
  ToolHandler,
  ToolResultEnvelope,
  ToolResultMetadata,
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
