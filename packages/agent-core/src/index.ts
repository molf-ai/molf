export { Agent } from "./agent.js";
export { Session, generateMessageId, convertToModelMessages } from "./session.js";
export type { SerializedSession } from "./session.js";
export { pruneContext, isContextLengthError } from "./context-pruner.js";
export { ToolRegistry } from "./tool-registry.js";
export { createConfig } from "./config.js";
export { getDefaultSystemPrompt, buildSystemPrompt } from "./system-prompts.js";

// Env namespace
export { Env } from "./env.js";

// Provider system
export type {
  ProviderModel,
  ProviderInfo,
  ResolvedModel,
  ModelId,
  ModelRef,
  ProviderState,
  ProviderRegistryConfig,
} from "./providers/index.js";
export {
  parseModelId,
  formatModelId,
  initProviders,
  resolveLanguageModel,
  getModel,
  listProviders,
  listModels,
  getCatalog,
  refreshCatalog,
  resetCatalog,
  ProviderTransform,
} from "./providers/index.js";

export type {
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  ToolCall,
  SessionMessageBase,
  SessionMessage,
  ResolvedAttachment,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  TurnCompleteEvent,
  AgentErrorEvent,
} from "./types.js";

export type { AgentConfig, BehaviorConfig } from "./config.js";
