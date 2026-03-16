import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolApprovalRequest } from "@molf-ai/protocol";
import { isTextInput } from "../keys.js";

interface Props {
  approvals: ToolApprovalRequest[];
  onApprove: (approvalId: string) => void;
  onAlwaysApprove: (approvalId: string) => void;
  onDeny: (approvalId: string, feedback?: string) => void;
}

export function ToolApprovalPrompt({ approvals, onApprove, onAlwaysApprove, onDeny }: Props) {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  const current = approvals[0] ?? null;

  // Reset feedback state when the current approval changes
  useEffect(() => {
    setFeedbackMode(false);
    setFeedbackText("");
  }, [current?.approvalId]);

  useInput((input, key) => {
    if (!current) return;

    if (feedbackMode) {
      if (key.return) {
        onDeny(current.approvalId, feedbackText || undefined);
        setFeedbackMode(false);
        setFeedbackText("");
      } else if (key.backspace || key.delete) {
        setFeedbackText((prev) => prev.slice(0, -1));
      } else if (isTextInput(input, key)) {
        setFeedbackText((prev) => prev + input);
      }
    } else {
      if (input === "y" || input === "Y") {
        onApprove(current.approvalId);
      } else if (input === "a" || input === "A") {
        onAlwaysApprove(current.approvalId);
      } else if (input === "n" || input === "N") {
        setFeedbackMode(true);
        setFeedbackText("");
      }
    }
  });

  if (!current) return null;

  const total = approvals.length;

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Tool Approval Required
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text dimColor>[{1}/{total}]</Text>{" "}
          <Text bold>{current.toolName}</Text>
          <Text dimColor>({current.arguments})</Text>
        </Text>
      </Box>
      {feedbackMode ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Leave feedback for the LLM (Enter to skip):</Text>
          <Text>{feedbackText}<Text color="green">_</Text></Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>
            Press <Text bold color="green">Y</Text> to approve, <Text bold color="cyan">A</Text> to always approve, <Text bold color="red">N</Text> to deny
          </Text>
        </Box>
      )}
    </Box>
  );
}
