import type { SlashCommand, CommandMatchResult } from "./types.js";

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliasMap = new Map<string, string>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases) {
      this.aliasMap.set(alias, command.name);
    }
  }

  parse(input: string): CommandMatchResult {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
      return { type: "not_command" };
    }

    const spaceIndex = trimmed.indexOf(" ");
    const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

    const resolved = this.aliasMap.get(name) ?? name;
    const command = this.commands.get(resolved);

    if (command) {
      return { type: "exact", command, args };
    }

    return { type: "no_match", input: trimmed };
  }

  getCompletions(prefix: string): SlashCommand[] {
    const lower = prefix.toLowerCase();
    const matched = new Set<string>();
    const results: SlashCommand[] = [];

    for (const [name, command] of this.commands) {
      if (name.startsWith(lower)) {
        if (!matched.has(command.name)) {
          matched.add(command.name);
          results.push(command);
        }
      }
    }

    for (const [alias, commandName] of this.aliasMap) {
      if (alias.startsWith(lower) && !matched.has(commandName)) {
        matched.add(commandName);
        const command = this.commands.get(commandName)!;
        results.push(command);
      }
    }

    return results;
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }
}
