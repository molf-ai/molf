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

// oRPC contract
export { contract } from "./contract.js";
export type { ContractRouterClient } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "./contract.js";
export type RpcClient = ContractRouterClient<typeof contract>;

// Backoff utility
export { backoffDelay } from "./backoff.js";

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
  workerToolCancelSchema,
  workerToolResultInput,
  workerToolResultOutput,
  // Worker upload
  workerUploadRequestSchema,
  workerUploadResultInput,
  workerUploadResultOutput,
  workerFetchUploadInput,
  workerFetchUploadOutput,
  // Worker sync state
  workerSyncStateOutput,
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
  // Provider
  providerListProvidersOutput,
  providerListModelsInput,
  providerListModelsOutput,
  providerSetKeyInput,
  providerSetKeyOutput,
  providerRemoveKeyInput,
  providerRemoveKeyOutput,
  providerAddCustomInput,
  providerAddCustomOutput,
  providerUpdateCustomInput,
  providerUpdateCustomOutput,
  providerRemoveCustomInput,
  providerRemoveCustomOutput,
  providerGetCustomInput,
  providerGetCustomOutput,
  providerListCustomOutput,
  // Config
  configGetOutput,
  configSetInput,
  configSetOutput,
  configEventSchema,
  // Auth
  authCreatePairingCodeInput,
  authCreatePairingCodeOutput,
  authRedeemPairingCodeInput,
  authRedeemPairingCodeOutput,
  authListApiKeysOutput,
  authRevokeApiKeyInput,
  authRevokeApiKeyOutput,
  // File transfer
  fileUploadInput,
  fileUploadOutput,
  // Plugin
  pluginCallInput,
  pluginCallOutput,
  pluginListOutput,
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
  ToolApprovalResolvedEvent,
  ContextCompactedEvent,
  SessionMessageBase,
  SessionMessage,
  ToolCall,
  FileRef,
  UploadRequest,
  FetchUploadResult,
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
  WorkerRegistration,
  KnownWorker,
  ClientRegistration,
  Registration,
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
  PathArgConfig,
  WorkerTool,
} from "./types.js";

// Constants
export {
  MAX_ATTACHMENT_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  TOOL_DISPATCH_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  IDLE_EVICTION_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from "./constants.js";

// Helpers
export {
  errorMessage,
  lastMessagePreview,
} from "./helpers.js";

// Server entries (credentials)
export {
  loadServer,
  saveServer,
  removeServer,
  getServersPath,
  getClientDataDir,
  saveTlsCert,
  loadTlsCertPem,
  removeTlsCert,
  type ServerEntry,
  type ServersFile,
  // Deprecated aliases for backward compatibility
  loadCredential,
  saveCredential,
  removeCredential,
  getCredentialsPath,
  type ServerCredential,
  type CredentialsFile,
} from "./credentials.js";

// Plugin system
export {
  // Core functions
  definePlugin,
  defineRoutes,
  createPluginClient,
  // HookRegistry
  HookRegistry,
  // Hook mode map
  HOOK_MODES,
  // Blockable hooks set
  BLOCKABLE_HOOKS,
} from "./plugin.js";

export type {
  // Hook events
  ServerHookEvents,
  WorkerHookEvents,
  AllHookEvents,
  // Hook types
  HookMode,
  HookHandlerFn,
  HookHandlerResult,
  ModifyResult,
  HookLogger,
  // Route types
  RouteDefinition,
  RouteMap,
  PluginRpcClient,
  PluginClient,
  // Plugin API interfaces
  SessionToolContext,
  ISessionManager,
  IAgentRunner,
  IConnectionRegistry,
  IWorkspaceStore,
  IServerBus,
  ChannelScope,
  ConfigEvent,
  ProviderSummary,
  ServerEvent,
  ServerPluginApi,
  WorkerPluginApi,
  // Plugin descriptor
  PluginDescriptor,
  PluginCleanup,
} from "./plugin.js";

// WebSocket helpers
export { createAuthWebSocket, createUnauthWebSocket, probeServerCert } from "./ws.js";

// Cert trust
export {
  resolveTlsTrust,
  tlsTrustToWsOpts,
  computeFingerprintFromDer,
  computeFingerprintFromPem,
  derToPem,
  checkPinnedCertExpiry,
} from "./cert-trust.js";
export type { TlsTrust } from "./cert-trust.js";

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
