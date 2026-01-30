import React from "react";
import { Box, Text, useInput } from "ink";
import type { ToolApprovalRequest } from "@molf-ai/protocol";

interface Props {
  approvals: ToolApprovalRequest[];
  onApprove: (toolCallId: string) => void;
  onDeny: (toolCallId: string) => void;
}

export function ToolApprovalPrompt({ approvals, onApprove, onDeny }: Props) {
  if (approvals.length === 0) return null;

  const current = approvals[0];

  useInput((input) => {
    if (input === "y" || input === "Y") {
      onApprove(current.toolCallId);
    } else if (input === "n" || input === "N") {
      onDeny(current.toolCallId);
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Tool Approval Required ({approvals.length} pending)
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>{current.toolName}</Text>
          <Text dimColor>({current.arguments})</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Press <Text bold color="green">Y</Text> to approve, <Text bold color="red">N</Text> to deny
        </Text>
      </Box>
    </Box>
  );
}
