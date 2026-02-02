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
import { WorkerPicker } from "./components/worker-picker.js";
import { useServer } from "./hooks/use-server.js";
import { useInputHistory } from "./hooks/use-input-history.js";
import { useCommands } from "./hooks/use-commands.js";
import {
  CommandRegistry,
  clearCommand,
  exitCommand,
  makeHelpCommand,
  sessionsCommand,
  renameCommand,
  workerCommand,
  editorCommand,
} from "./commands/index.js";
import type { CommandContext } from "./commands/index.js";
import { useExternalEditor } from "./hooks/use-external-editor.js";

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
  const [isPickingWorker, setIsPickingWorker] = useState(false);

  const { write: writeStdout } = useStdout();
  const prevPickingRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);

  const server = useServer({ url: serverUrl, token, sessionId, workerId });

  const editor = useExternalEditor({
    onContent: (content) => {
      setInputValue(content);
    },
    onError: (message) => {
      server.addSystemMessage(message);
    },
  });

  const isBusy = server.status === "streaming" || server.status === "executing_tool" || editor.isEditing;

  const history = useInputHistory(server.messages);

  // Clear terminal when entering/leaving picker modals so Static output doesn't linger
  const isPicking = isPickingSession || isPickingWorker;
  useEffect(() => {
    if (isPicking !== prevPickingRef.current) {
      prevPickingRef.current = isPicking;
      writeStdout("\x1B[2J\x1B[H");
    }
  }, [isPicking, writeStdout]);

  const registry = useMemo(() => {
    const reg = new CommandRegistry();
    reg.register(clearCommand);
    reg.register(exitCommand);
    reg.register(sessionsCommand);
    reg.register(renameCommand);
    reg.register(workerCommand);
    reg.register(editorCommand);
    // Help command needs the registry to list all commands
    reg.register(makeHelpCommand(reg));
    return reg;
  }, []);

  const clearScreen = useCallback(() => {
    writeStdout("\x1B[2J\x1B[H");
  }, [writeStdout]);

  const commandContext: CommandContext = useMemo(
    () => ({
      addSystemMessage: server.addSystemMessage,
      newSession: server.newSession,
      clearScreen,
      exit,
      listSessions: server.listSessions,
      switchSession: server.switchSession,
      enterSessionPicker: () => setIsPickingSession(true),
      enterWorkerPicker: () => setIsPickingWorker(true),
      renameSession: server.renameSession,
      openEditor: editor.openEditor,
    }),
    [server.addSystemMessage, server.newSession, clearScreen, exit, server.listSessions, server.switchSession, server.renameSession, editor.openEditor],
  );

  const commands = useCommands({
    registry,
    context: commandContext,
    inputValue,
  });

  // App-level input: only handles Escape, Ctrl+C, and autocomplete navigation
  // All text editing, cursor movement, and Enter/submit are handled by TextArea
  useInput((input, key) => {
    if (isPickingSession || isPickingWorker || editor.isEditing) return;

    // Ctrl+C: always exit
    if (input === "\x03") {
      exit();
      return;
    }

    // Ctrl+G: open external editor
    if (key.ctrl && input === "g") {
      editor.openEditor(inputValue);
      return;
    }

    // Ctrl+L: clear screen and start new session
    if (key.ctrl && input === "l") {
      clearScreen();
      server.newSession().then(() => {
        server.addSystemMessage("New session started.");
      });
      setInputValue("");
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

    // Autocomplete navigation (only capture arrows when multiple completions offer a real choice)
    if (commands.isCommandMode && commands.completions.length > 1) {
      if (key.upArrow) {
        commands.selectPrevious();
        return;
      }
      if (key.downArrow) {
        commands.selectNext();
        return;
      }
    }
    if (commands.isCommandMode && commands.completions.length > 0) {
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

      // If autocomplete has a selected command, execute that instead of the raw input
      const completed = commands.isCommandMode && commands.completions.length > 0
        ? commands.acceptCompletion()
        : null;
      const effective = completed ?? value;

      if (commands.tryExecute(effective)) {
        history.addEntry(effective);
        setInputValue("");
        return;
      }

      history.addEntry(effective);
      server.sendMessage(effective);
      setInputValue("");
    },
    [isBusy, commands, server, history],
  );

  // History navigation callbacks from TextArea overflow
  const handleOverflowUp = useCallback(() => {
    const val = history.navigateUp(inputValue);
    if (val !== undefined) setInputValue(val);
  }, [history, inputValue]);

  const handleOverflowDown = useCallback(() => {
    const val = history.navigateDown(inputValue);
    if (val !== undefined) setInputValue(val);
  }, [history, inputValue]);

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

  const handleWorkerSelect = useCallback(
    (selectedWorkerId: string) => {
      setIsPickingWorker(false);
      server.switchWorker(selectedWorkerId);
    },
    [server],
  );

  const handleWorkerPickerCancel = useCallback(() => {
    setIsPickingWorker(false);
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

  if (isPickingWorker) {
    return (
      <Box flexDirection="column" padding={1}>
        <WorkerPicker
          listWorkers={server.listWorkers}
          onSelect={handleWorkerSelect}
          onCancel={handleWorkerPickerCancel}
          currentWorkerId={server.workerId}
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
          {server.workerName ? ` [${server.workerName}]` : ""}
          {" "}
          (Esc to {isBusy ? "abort" : "exit"}, Ctrl+L new session, /help for commands)
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
        onOverflowUp={handleOverflowUp}
        onOverflowDown={handleOverflowDown}
        suppressUpDown={commands.isCommandMode && commands.completions.length > 1}
        disabled={isBusy}
        disabledMessage={editor.isEditing ? "Editing in external editor... (save and close to return)" : undefined}
      />

      <AutocompletePopup
        completions={commands.completions}
        selectedIndex={commands.selectedIndex}
        visible={commands.isCommandMode && commands.completions.length > 0}
      />
    </Box>
  );
}
