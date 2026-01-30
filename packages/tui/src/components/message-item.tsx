import React from "react";
import { Box, Text } from "ink";
import type { DisplayMessage, ToolCallInfo } from "../types.js";

interface Props {
  message: DisplayMessage;
  completedToolCalls?: ToolCallInfo[];
}

export function MessageItem({ message, completedToolCalls }: Props) {
  const isUser = message.role === "user";
  const isToolResult = message.role === "tool";
  const isSystem = message.role === "system";

  const roleLabel = isSystem ? "System" : isUser ? "You" : isToolResult ? "Tool" : "Molf";
  const roleColor = isSystem ? "magenta" : isUser ? "cyan" : isToolResult ? "yellow" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {completedToolCalls && completedToolCalls.length > 0 && (
        <Box flexDirection="column" marginBottom={0}>
          {completedToolCalls.map((tc, i) => {
            const isSkill = tc.toolName === "skill";
            let skillName: string | null = null;
            if (isSkill) {
              try { skillName = JSON.parse(tc.arguments).name ?? null; } catch { /* ignore */ }
            }

            return (
              <Box key={`${tc.toolName}-${i}`} flexDirection="column" marginLeft={2}>
                {isSkill && skillName ? (
                  <Text color="gray">{">> "}Loaded skill: {skillName}</Text>
                ) : (
                  <>
                    <Text color="gray">
                      {">> "}{tc.toolName}({tc.arguments})
                    </Text>
                    {tc.result && (
                      <Text color="gray" dimColor>
                        {"   "}{tc.result}
                      </Text>
                    )}
                  </>
                )}
              </Box>
            );
          })}
        </Box>
      )}
      <Text bold color={roleColor}>
        {roleLabel}
      </Text>
      <Box marginLeft={2}>
        <Text wrap="wrap" dimColor={isSystem}>{message.content}</Text>
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
