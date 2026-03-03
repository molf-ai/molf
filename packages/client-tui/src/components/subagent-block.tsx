import React from "react";
import { Box, Text } from "ink";
import type { SubagentState } from "../hooks/event-reducer.js";

interface Props {
  subagents: Record<string, SubagentState>;
}

export function SubagentBlock({ subagents }: Props) {
  const entries = Object.values(subagents);
  if (entries.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {entries.map((sa) => {
        const done = sa.status === "idle" && sa.completedToolCallCount > 0;

        if (done) {
          return (
            <Box key={sa.sessionId} marginLeft={2}>
              <Text color="green">{"✓ "}@{sa.agentType}</Text>
              <Text dimColor> ({sa.completedToolCallCount} tools)</Text>
            </Box>
          );
        }

        // Active subagent
        const toolNames = sa.activeToolCalls.map((tc) => tc.toolName).join(", ");
        const tail = sa.streamingContent
          ? sa.streamingContent.slice(-120).replace(/\n/g, " ")
          : "";

        return (
          <Box key={sa.sessionId} flexDirection="column" marginLeft={2}>
            <Box>
              <Text color="cyan">{"▸ "}@{sa.agentType}</Text>
              {toolNames && <Text dimColor> [{toolNames}]</Text>}
            </Box>
            {tail && (
              <Box marginLeft={2}>
                <Text dimColor wrap="truncate">{tail}</Text>
              </Box>
            )}
            {sa.error && (
              <Box marginLeft={2}>
                <Text color="red">{sa.error}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
