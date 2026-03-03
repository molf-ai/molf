import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";

interface Props {
  toolCalls: ToolCallInfo[];
  filterTask?: boolean;
}

function parseSkillName(args: string): string | null {
  try {
    return JSON.parse(args).name ?? null;
  } catch {
    return null;
  }
}

export function ToolCallDisplay({ toolCalls, filterTask }: Props) {
  const visible = filterTask
    ? toolCalls.filter((tc) => tc.toolName !== "task")
    : toolCalls;
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((tc, i) => {
        const isSkill = tc.toolName === "skill";
        const skillName = isSkill ? parseSkillName(tc.arguments) : null;

        return (
          <Box key={`${tc.toolName}-${i}`} flexDirection="column" marginLeft={2}>
            {isSkill && skillName ? (
              <Text color="blue">{">> "}Loading skill: {skillName}</Text>
            ) : (
              <>
                <Text color="yellow">
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
  );
}
