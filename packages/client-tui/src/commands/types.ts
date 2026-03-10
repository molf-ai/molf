import type { SessionListItem } from "@molf-ai/protocol";

export interface CommandContext {
  addSystemMessage: (content: string) => void;
  newSession: () => Promise<void>;
  clearScreen: () => void;
  exit: () => void;
  listSessions: () => Promise<SessionListItem[]>;
  switchSession: (sessionId: string) => Promise<void>;
  enterSessionPicker: () => void;
  enterWorkerPicker: () => void;
  enterModelPicker: () => void;
  enterWorkspacePicker: () => void;
  renameSession: (name: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (name: string) => Promise<void>;
  openEditor: (initialContent?: string) => void;
  createPairingCode: (name: string) => Promise<{ code: string }>;
  enterKeysPicker: () => void;
}

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  execute: (ctx: CommandContext, args: string) => void | Promise<void>;
}

export type CommandMatchResult =
  | { type: "not_command" }
  | { type: "exact"; command: SlashCommand; args: string }
  | { type: "no_match"; input: string };
