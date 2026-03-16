import React from "react";
import { Box, Text } from "ink";

interface PickerLoadingProps {
  children?: string;
}

/** Yellow "Loading..." text for pickers. */
export function PickerLoading({ children = "Loading..." }: PickerLoadingProps) {
  return (
    <Box>
      <Text color="yellow">{children}</Text>
    </Box>
  );
}

interface PickerEmptyProps {
  children: string;
}

/** Dimmed empty-state message with Escape hint. */
export function PickerEmpty({ children }: PickerEmptyProps) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{children} Press Escape to go back.</Text>
    </Box>
  );
}
