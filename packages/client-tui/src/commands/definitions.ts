import type { SlashCommand } from "./types.js";
import type { CommandRegistry } from "./registry.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["new", "reset"],
  description: "Start a new session (old session preserved)",
  execute: async (ctx) => {
    ctx.clearScreen();
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

export const modelCommand: SlashCommand = {
  name: "model",
  aliases: ["m"],
  description: "List and switch between models",
  execute: (ctx) => {
    ctx.enterModelPicker();
  },
};

export const workspaceCommand: SlashCommand = {
  name: "workspace",
  aliases: ["ws"],
  description: "Browse and manage workspaces",
  execute: async (ctx, args) => {
    if (!args) {
      ctx.enterWorkspacePicker();
      return;
    }
    const spaceIdx = args.indexOf(" ");
    const subcommand = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const arg = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim().replace(/^["']|["']$/g, "");

    if (subcommand === "new") {
      if (!arg) {
        ctx.addSystemMessage('Usage: /workspace new "name"');
        return;
      }
      await ctx.createWorkspace(arg);
      ctx.clearScreen();
      ctx.addSystemMessage(`Workspace "${arg}" created.`);
    } else if (subcommand === "rename") {
      if (!arg) {
        ctx.addSystemMessage('Usage: /workspace rename "name"');
        return;
      }
      await ctx.renameWorkspace(arg);
      ctx.addSystemMessage(`Workspace renamed to "${arg}".`);
    } else {
      ctx.addSystemMessage('Usage: /workspace [new "name" | rename "name"]');
    }
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
