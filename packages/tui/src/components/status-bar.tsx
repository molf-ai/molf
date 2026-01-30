import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { AgentStatus } from "@molf-ai/protocol";

interface Props {
  status: AgentStatus;
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "",
  streaming: "Thinking...",
  executing_tool: "Running tool...",
  error: "An error occurred",
  aborted: "Aborted",
};

export function StatusBar({ status }: Props) {
  if (status === "idle") return null;

  const isActive = status === "streaming" || status === "executing_tool";
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
