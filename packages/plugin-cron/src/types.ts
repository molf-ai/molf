import type { CronJob } from "@molf-ai/protocol";

/** Callback type for triggering an agent turn in a session. */
export type PromptFn = (
  sessionId: string,
  text: string,
  options?: { synthetic?: boolean },
) => Promise<{ messageId: string }>;

/** Agent busy error for retry detection. */
export class AgentBusyError extends Error {
  constructor() {
    super("Agent is already processing a prompt");
    this.name = "AgentBusyError";
  }
}

export type { CronJob };
