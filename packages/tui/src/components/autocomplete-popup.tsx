import React from "react";
import { Box, Text } from "ink";
import type { SlashCommand } from "../commands/types.js";

interface Props {
  completions: SlashCommand[];
  selectedIndex: number;
  visible: boolean;
}

export function AutocompletePopup({ completions, selectedIndex, visible }: Props) {
  if (!visible || completions.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {completions.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {isSelected ? "> " : "  "}
              /{cmd.name}
            </Text>
            <Text dimColor> — {cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
