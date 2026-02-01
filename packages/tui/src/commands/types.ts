import type { SessionListItem } from "@molf-ai/protocol";

export interface CommandContext {
  addSystemMessage: (content: string) => void;
  newSession: () => Promise<void>;
  exit: () => void;
  listSessions: () => Promise<SessionListItem[]>;
  switchSession: (sessionId: string) => Promise<void>;
  enterSessionPicker: () => void;
  renameSession: (name: string) => Promise<void>;
  openEditor: (initialContent?: string) => void;
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
