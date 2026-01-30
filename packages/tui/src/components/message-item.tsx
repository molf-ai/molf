import React from "react";
import { Box, Text } from "ink";
import type { SessionMessage } from "@molf-ai/protocol";
import type { ToolCallInfo } from "../types.js";

interface Props {
  message: SessionMessage;
  completedToolCalls?: ToolCallInfo[];
}

export function MessageItem({ message, completedToolCalls }: Props) {
  const isUser = message.role === "user";
  const isToolResult = message.role === "tool";

  const roleLabel = isUser ? "You" : isToolResult ? "Tool" : "Molf";
  const roleColor = isUser ? "cyan" : isToolResult ? "yellow" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {completedToolCalls && completedToolCalls.length > 0 && (
        <Box flexDirection="column" marginBottom={0}>
          {completedToolCalls.map((tc, i) => (
            <Box key={`${tc.toolName}-${i}`} flexDirection="column" marginLeft={2}>
              <Text color="gray">
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
      )}
      <Text bold color={roleColor}>
        {roleLabel}
      </Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
      {!completedToolCalls && message.toolCalls && message.toolCalls.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>
            [Called {message.toolCalls.map((tc) => tc.toolName).join(", ")}]
          </Text>
        </Box>
      )}
    </Box>
  );
}
