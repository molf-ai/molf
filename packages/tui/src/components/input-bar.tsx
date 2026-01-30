import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBar({ value, onChange, onSubmit, disabled }: Props) {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>{"  "}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text bold color="cyan">
        {"❯ "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={!disabled}
        placeholder="Type a message..."
      />
    </Box>
  );
}
