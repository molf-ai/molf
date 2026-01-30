import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ChatHistory } from "./components/chat-history.js";
import { StreamingResponse } from "./components/streaming-response.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { ToolCallDisplay } from "./components/tool-call-display.js";
import { ToolApprovalPrompt } from "./components/tool-approval-prompt.js";
import { useServer } from "./hooks/use-server.js";

export interface AppProps {
  serverUrl: string;
  token: string;
  sessionId?: string;
  workerId?: string;
}

export function App({ serverUrl, token, sessionId, workerId }: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");

  const {
    messages,
    status,
    streamingContent,
    activeToolCalls,
    completedToolCalls,
    error,
    connected,
    pendingApprovals,
    sendMessage,
    abort,
    approveToolCall,
    denyToolCall,
  } = useServer({ url: serverUrl, token, sessionId, workerId });

  const isBusy = status === "streaming" || status === "executing_tool";

  useInput((input, key) => {
    if (key.escape) {
      if (isBusy) {
        abort();
      } else {
        exit();
      }
    }
  });

  const handleSubmit = (value: string) => {
    if (value.trim() === "" || isBusy) return;
    sendMessage(value);
    setInputValue("");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Molf Assistant
        </Text>
        <Text dimColor>
          {" "}
          ({connected ? "connected" : "disconnected"})
          {" "}
          (Esc to {isBusy ? "abort" : "exit"})
        </Text>
      </Box>

      <ChatHistory messages={messages} completedToolCalls={completedToolCalls} />

      <ToolCallDisplay toolCalls={activeToolCalls} />

      <StreamingResponse content={streamingContent} visible={isBusy} />

      <StatusBar status={status} />

      {pendingApprovals.length > 0 && (
        <ToolApprovalPrompt
          approvals={pendingApprovals}
          onApprove={approveToolCall}
          onDeny={denyToolCall}
        />
      )}

      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error.message}</Text>
        </Box>
      )}

      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        disabled={isBusy}
      />
    </Box>
  );
}
