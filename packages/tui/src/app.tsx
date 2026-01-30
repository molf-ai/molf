import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ChatHistory } from "./components/chat-history.js";
import { StreamingResponse } from "./components/streaming-response.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { ToolCallDisplay } from "./components/tool-call-display.js";
import { ToolApprovalPrompt } from "./components/tool-approval-prompt.js";
import { AutocompletePopup } from "./components/autocomplete-popup.js";
import { SessionPicker } from "./components/session-picker.js";
import { useServer } from "./hooks/use-server.js";
import { useCommands } from "./hooks/use-commands.js";
import {
  CommandRegistry,
  clearCommand,
  exitCommand,
  makeHelpCommand,
  sessionsCommand,
  renameCommand,
} from "./commands/index.js";
import type { CommandContext } from "./commands/index.js";

export interface AppProps {
  serverUrl: string;
  token: string;
  sessionId?: string;
  workerId?: string;
}

export function App({ serverUrl, token, sessionId, workerId }: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");
  const [isPickingSession, setIsPickingSession] = useState(false);

  const { write: writeStdout } = useStdout();
  const prevPickingRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);

  const server = useServer({ url: serverUrl, token, sessionId, workerId });

  const isBusy = server.status === "streaming" || server.status === "executing_tool";

  // Clear terminal when entering/leaving session picker so Static output doesn't linger
  useEffect(() => {
    if (isPickingSession !== prevPickingRef.current) {
      prevPickingRef.current = isPickingSession;
      writeStdout("\x1B[2J\x1B[H");
    }
  }, [isPickingSession, writeStdout]);

  // Clear terminal when session changes (e.g. /clear, /sessions select)
  useEffect(() => {
    if (prevSessionIdRef.current !== null && server.sessionId !== prevSessionIdRef.current) {
      writeStdout("\x1B[2J\x1B[H");
    }
    prevSessionIdRef.current = server.sessionId;
  }, [server.sessionId, writeStdout]);

  const registry = useMemo(() => {
    const reg = new CommandRegistry();
    reg.register(clearCommand);
    reg.register(exitCommand);
    reg.register(sessionsCommand);
    reg.register(renameCommand);
    // Help command needs the registry to list all commands
    reg.register(makeHelpCommand(reg));
    return reg;
  }, []);

  const commandContext: CommandContext = useMemo(
    () => ({
      addSystemMessage: server.addSystemMessage,
      newSession: server.newSession,
      exit,
      listSessions: server.listSessions,
      switchSession: server.switchSession,
      enterSessionPicker: () => setIsPickingSession(true),
      renameSession: server.renameSession,
    }),
    [server.addSystemMessage, server.newSession, exit, server.listSessions, server.switchSession, server.renameSession],
  );

  const commands = useCommands({
    registry,
    context: commandContext,
    inputValue,
  });

  useInput((input, key) => {
    if (isPickingSession) return;

    // Ctrl+C: always exit
    if (input === "\x03") {
      exit();
      return;
    }

    if (key.escape) {
      if (commands.isCommandMode && commands.completions.length > 0) {
        setInputValue("");
      } else if (isBusy) {
        server.abort();
      } else {
        exit();
      }
      return;
    }

    // Autocomplete navigation
    if (commands.isCommandMode && commands.completions.length > 0) {
      if (key.upArrow) {
        commands.selectPrevious();
        return;
      }
      if (key.downArrow) {
        commands.selectNext();
        return;
      }
      if (key.tab) {
        const completed = commands.acceptCompletion();
        if (completed) {
          setInputValue(completed);
        }
        return;
      }
    }
  });

  const handleSubmit = useCallback(
    (value: string) => {
      if (value.trim() === "" || isBusy) return;

      if (commands.tryExecute(value)) {
        setInputValue("");
        return;
      }

      server.sendMessage(value);
      setInputValue("");
    },
    [isBusy, commands, server],
  );

  const handleSessionSelect = useCallback(
    (selectedSessionId: string) => {
      setIsPickingSession(false);
      server.switchSession(selectedSessionId);
    },
    [server],
  );

  const handleSessionPickerCancel = useCallback(() => {
    setIsPickingSession(false);
  }, []);

  if (isPickingSession) {
    return (
      <Box flexDirection="column" padding={1}>
        <SessionPicker
          listSessions={server.listSessions}
          onSelect={handleSessionSelect}
          onCancel={handleSessionPickerCancel}
          currentSessionId={server.sessionId}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Molf Assistant
        </Text>
        <Text dimColor>
          {" "}
          ({server.connected ? "connected" : "disconnected"})
          {" "}
          (Esc to {isBusy ? "abort" : "exit"}, /help for commands)
        </Text>
      </Box>

      <ChatHistory key={server.sessionId} messages={server.messages} completedToolCalls={server.completedToolCalls} />

      <ToolCallDisplay toolCalls={server.activeToolCalls} />

      <StreamingResponse content={server.streamingContent} visible={isBusy} />

      <StatusBar status={server.status} />

      {server.pendingApprovals.length > 0 && (
        <ToolApprovalPrompt
          approvals={server.pendingApprovals}
          onApprove={server.approveToolCall}
          onDeny={server.denyToolCall}
        />
      )}

      {server.error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {server.error.message}</Text>
        </Box>
      )}

      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        disabled={isBusy}
      />

      <AutocompletePopup
        completions={commands.completions}
        selectedIndex={commands.selectedIndex}
        visible={commands.isCommandMode && commands.completions.length > 0}
      />
    </Box>
  );
}
