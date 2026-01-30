import { useState, useMemo, useCallback } from "react";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, SlashCommand } from "../commands/types.js";

export interface UseCommandsOptions {
  registry: CommandRegistry;
  context: CommandContext;
  inputValue: string;
}

export interface UseCommandsReturn {
  isCommandMode: boolean;
  completions: SlashCommand[];
  selectedIndex: number;
  selectPrevious: () => void;
  selectNext: () => void;
  acceptCompletion: () => string | null;
  tryExecute: (input: string) => boolean;
}

export function useCommands({ registry, context, inputValue }: UseCommandsOptions): UseCommandsReturn {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const isCommandMode = inputValue.startsWith("/");

  const completions = useMemo(() => {
    if (!isCommandMode) return [];
    const prefix = inputValue.slice(1);
    const results = registry.getCompletions(prefix);
    setSelectedIndex(0);
    return results;
  }, [isCommandMode, inputValue, registry]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? completions.length - 1 : prev - 1));
  }, [completions.length]);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => (prev >= completions.length - 1 ? 0 : prev + 1));
  }, [completions.length]);

  const acceptCompletion = useCallback((): string | null => {
    if (completions.length === 0) return null;
    const command = completions[selectedIndex];
    if (!command) return null;
    return `/${command.name} `;
  }, [completions, selectedIndex]);

  const tryExecute = useCallback((input: string): boolean => {
    const result = registry.parse(input);
    if (result.type === "exact") {
      const maybePromise = result.command.execute(context, result.args);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          context.addSystemMessage(`Command error: ${message}`);
        });
      }
      return true;
    }
    if (result.type === "no_match") {
      context.addSystemMessage(`Unknown command: ${result.input}. Type /help for available commands.`);
      return true;
    }
    return false;
  }, [registry, context]);

  return {
    isCommandMode,
    completions,
    selectedIndex,
    selectPrevious,
    selectNext,
    acceptCompletion,
    tryExecute,
  };
}
