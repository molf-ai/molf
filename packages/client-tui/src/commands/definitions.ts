import type { SlashCommand } from "./types.js";
import type { CommandRegistry } from "./registry.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["new", "reset"],
  description: "Start a new session (old session preserved)",
  execute: async (ctx) => {
    await ctx.newSession();
    ctx.addSystemMessage("New session started.");
  },
};

export const exitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit", "q"],
  description: "Exit the TUI",
  execute: (ctx) => {
    ctx.exit();
  },
};

export function makeHelpCommand(registry: CommandRegistry): SlashCommand {
  return {
    name: "help",
    aliases: ["commands"],
    description: "Show all available commands",
    execute: (ctx) => {
      const commands = registry.getAll();
      const lines = commands.map((cmd) => {
        const aliases = cmd.aliases.length > 0
          ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
          : "";
        return `  /${cmd.name}${aliases} — ${cmd.description}`;
      });
      ctx.addSystemMessage("Available commands:\n" + lines.join("\n"));
    },
  };
}

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  aliases: ["resume"],
  description: "Browse and switch sessions",
  execute: (ctx) => {
    ctx.enterSessionPicker();
  },
};

export const renameCommand: SlashCommand = {
  name: "rename",
  aliases: [],
  description: "Rename the current session",
  execute: async (ctx, args) => {
    if (!args) {
      ctx.addSystemMessage("Usage: /rename <new name>");
      return;
    }
    await ctx.renameSession(args);
    ctx.addSystemMessage(`Session renamed to "${args}".`);
  },
};

export const workerCommand: SlashCommand = {
  name: "worker",
  aliases: ["workers", "w"],
  description: "List and switch between workers",
  execute: (ctx) => {
    ctx.enterWorkerPicker();
  },
};

export const editorCommand: SlashCommand = {
  name: "editor",
  aliases: ["edit", "e"],
  description: "Open $EDITOR to compose a message",
  execute: (ctx) => {
    ctx.openEditor();
  },
};
