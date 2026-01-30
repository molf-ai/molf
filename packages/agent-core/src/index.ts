export { Agent } from "./agent.js";
export { Session, generateMessageId } from "./session.js";
export type { SerializedSession } from "./session.js";
export { ToolRegistry } from "./tool-registry.js";
export { createConfig } from "./config.js";
export { getDefaultSystemPrompt, buildSystemPrompt } from "./system-prompts.js";

// Built-in tools
export {
  getBuiltinTools,
  shellExecTool,
  readFileTool,
  writeFileTool,
} from "./tools/index.js";

// Re-export TanStack AI tool utilities
export { toolDefinition } from "@tanstack/ai";
export type { Tool, ServerTool } from "@tanstack/ai";

export type {
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  AgentToolDefinition,
  SessionMessage,
  StatusChangeEvent,
  ContentDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  TurnCompleteEvent,
  AgentErrorEvent,
} from "./types.js";

export type { AgentConfig, LLMConfig, BehaviorConfig } from "./config.js";
