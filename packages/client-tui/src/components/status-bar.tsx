import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { AgentStatus } from "@molf-ai/protocol";

interface Props {
  status: AgentStatus;
  shellRunning?: boolean;
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "",
  streaming: "Thinking...",
  executing_tool: "Running tool...",
  error: "An error occurred",
  aborted: "Aborted",
};

export function StatusBar({ status, shellRunning }: Props) {
  if (status === "idle" && !shellRunning) return null;

  const isActive = status === "streaming" || status === "executing_tool";

  if (shellRunning && status === "idle") {
    return (
      <Box marginBottom={1}>
        <Text color="yellow">
          <Spinner type="dots" />{" "}
        </Text>
        <Text dimColor>Running shell command...</Text>
      </Box>
    );
  }

  const label = STATUS_LABELS[status];

  return (
    <Box marginBottom={1}>
      {isActive && (
        <Text color="yellow">
          <Spinner type="dots" />{" "}
        </Text>
      )}
      <Text dimColor>{label}</Text>
    </Box>
  );
}
