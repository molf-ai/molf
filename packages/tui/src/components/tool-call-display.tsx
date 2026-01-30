import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";

interface Props {
  toolCalls: ToolCallInfo[];
}

export function ToolCallDisplay({ toolCalls }: Props) {
  if (toolCalls.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {toolCalls.map((tc, i) => (
        <Box key={`${tc.toolName}-${i}`} flexDirection="column" marginLeft={2}>
          <Text color="yellow">
            {">> "}{tc.toolName}({tc.arguments})
          </Text>
          {tc.result && (
            <Text color="gray" dimColor>
              {"   "}{tc.result}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
