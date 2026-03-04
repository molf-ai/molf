import type { Agent } from "@molf-ai/agent-core";
import type { ResolvedModel } from "@molf-ai/agent-core";
import type { AgentStatus } from "@molf-ai/protocol";

export interface CachedSession {
  agent: Agent;
  sessionId: string;
  workerId: string;
  status: AgentStatus;
  lastActiveAt: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  summarizing?: boolean;
  /** Tracks which nested instruction file paths have already been injected for this session. */
  loadedInstructions: Set<string>;
  /** The model used in the last turn (for summarization). */
  lastResolvedModel?: ResolvedModel;
}
