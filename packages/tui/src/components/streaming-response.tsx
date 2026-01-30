import React from "react";
import { Box, Text } from "ink";

interface Props {
  content: string;
  visible: boolean;
}

export function StreamingResponse({ content, visible }: Props) {
  if (!visible || !content) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">
        Molf
      </Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}
