import type { CronJob } from "@molf-ai/protocol";

/** Callback type for triggering an agent turn in a session. */
export type PromptFn = (
  sessionId: string,
  text: string,
  options?: { synthetic?: boolean },
) => Promise<{ messageId: string; queued?: boolean }>;

/**
 * Thrown when the agent's message queue is full. Replaces the former
 * AgentBusyError — now that prompts queue instead of rejecting outright,
 * the only rejection case is a full queue. Same retry semantics apply:
 * cron jobs reschedule after BUSY_RETRY_MS when they catch this.
 */
export class QueueFullError extends Error {
  constructor() {
    super("Message queue is full");
    this.name = "QueueFullError";
  }
}

export type { CronJob };
