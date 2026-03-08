import type { CronJob, SessionMessage } from "@molf-ai/protocol";

/** Subset of ConnectionRegistry needed by CronService. */
export interface CronConnectionRegistry {
  getWorker(id: string): { id: string; name: string } | undefined;
}

/** Subset of SessionManager needed by CronService. */
export interface CronSessionManager {
  load(sessionId: string): { workerId: string; workspaceId: string } | null;
  create(params: { workerId: string; workspaceId: string }): Promise<{ sessionId: string }>;
  addMessage(sessionId: string, message: SessionMessage): void;
  save(sessionId: string): Promise<void>;
}

/** Subset of WorkspaceStore needed by CronService. */
export interface CronWorkspaceStore {
  get(workerId: string, workspaceId: string): Promise<{ lastSessionId: string } | null | undefined>;
  addSession(workerId: string, workspaceId: string, sessionId: string): Promise<void>;
}

/** Subset of WorkspaceNotifier needed by CronService. */
export interface CronWorkspaceNotifier {
  emit(workerId: string, workspaceId: string, event: Record<string, unknown>): void;
}

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
