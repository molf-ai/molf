import React from "react";
import { Box, Text } from "ink";
import { TextArea } from "./text-area.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onOverflowUp?: () => void;
  onOverflowDown?: () => void;
  /** When true, up/down arrows are suppressed in TextArea (for autocomplete) */
  suppressUpDown?: boolean;
  disabled: boolean;
  /** Message shown in place of the input when disabled */
  disabledMessage?: string;
}

export function InputBar({ value, onChange, onSubmit, onOverflowUp, onOverflowDown, suppressUpDown, disabled, disabledMessage }: Props) {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>{disabledMessage ? `  ${disabledMessage}` : "  "}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text bold color="cyan">
        {"❯ "}
      </Text>
      <TextArea
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onOverflowUp={onOverflowUp}
        onOverflowDown={onOverflowDown}
        isActive={!disabled}
        suppressUpDown={suppressUpDown}
        placeholder="Type a message..."
      />
    </Box>
  );
}
