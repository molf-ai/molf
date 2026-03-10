import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ChatHistory } from "./components/chat-history.js";
import { StreamingResponse } from "./components/streaming-response.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { ToolCallDisplay } from "./components/tool-call-display.js";
import { SubagentBlock } from "./components/subagent-block.js";
import { ToolApprovalPrompt } from "./components/tool-approval-prompt.js";
import { AutocompletePopup } from "./components/autocomplete-popup.js";
import { WorkspacePicker } from "./components/workspace-picker.js";
import { WorkerPicker } from "./components/worker-picker.js";
import { KeyPicker } from "./components/key-picker.js";
import { ModelPicker } from "./components/model-picker.js";
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
  modelCommand,
  workspaceCommand,
  pairCommand,
  keysCommand,
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
  const [workspacePickerLevel, setWorkspacePickerLevel] = useState<null | "workspaces" | "sessions">(null);
  const [isPickingWorker, setIsPickingWorker] = useState(false);
  const [isPickingModel, setIsPickingModel] = useState(false);
  const [isPickingKeys, setIsPickingKeys] = useState(false);

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

  const hasApprovals = server.pendingApprovals.length > 0;
  const isBusy = server.status === "streaming" || server.status === "executing_tool" || editor.isEditing;

  const history = useInputHistory(server.messages);

  // Clear terminal when entering/leaving picker modals so Static output doesn't linger
  const isPicking = workspacePickerLevel !== null || isPickingWorker || isPickingModel || isPickingKeys;
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
    reg.register(modelCommand);
    reg.register(workspaceCommand);
    reg.register(pairCommand);
    reg.register(keysCommand);
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
      enterSessionPicker: () => setWorkspacePickerLevel("sessions"),
      enterWorkerPicker: () => setIsPickingWorker(true),
      enterModelPicker: () => setIsPickingModel(true),
      enterWorkspacePicker: () => setWorkspacePickerLevel("workspaces"),
      renameSession: server.renameSession,
      createWorkspace: server.createWorkspace,
      renameWorkspace: server.renameWorkspace,
      openEditor: editor.openEditor,
      createPairingCode: server.createPairingCode,
      enterKeysPicker: () => setIsPickingKeys(true),
    }),
    [server.addSystemMessage, server.newSession, clearScreen, exit, server.listSessions, server.switchSession, server.renameSession, server.createWorkspace, server.renameWorkspace, editor.openEditor, server.createPairingCode],
  );

  const commands = useCommands({
    registry,
    context: commandContext,
    inputValue,
  });

  // App-level input: only handles Escape, Ctrl+C, and autocomplete navigation
  // All text editing, cursor movement, and Enter/submit are handled by TextArea
  useInput((input, key) => {
    if (workspacePickerLevel !== null || isPickingWorker || isPickingModel || isPickingKeys || editor.isEditing || hasApprovals) return;

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

      if (effective.startsWith("!!")) {
        const cmd = effective.slice(2).trim();
        if (cmd === "") return;
        history.addEntry(effective);
        server.executeShell(cmd, false);  // fire-and-forget
        setInputValue("");
        return;
      }

      if (effective.startsWith("!")) {
        const cmd = effective.slice(1).trim();
        if (cmd === "") return;
        history.addEntry(effective);
        server.executeShell(cmd, true);   // save to context
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

  // Workspace picker callbacks
  const handleWorkspaceSessionSelect = useCallback(
    (workspaceId: string, sessionId: string) => {
      setWorkspacePickerLevel(null);
      server.switchWorkspace(workspaceId, sessionId);
    },
    [server],
  );

  const handleWorkspaceCreate = useCallback(
    async (name: string) => {
      await server.createWorkspace(name);
      server.addSystemMessage(`Workspace "${name}" created.`);
    },
    [server],
  );

  const handleWorkspaceRename = useCallback(
    async (workspaceId: string, name: string) => {
      await server.renameWorkspace(name, workspaceId);
    },
    [server],
  );

  const handleWorkspacePickerCancel = useCallback(() => {
    setWorkspacePickerLevel(null);
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

  const handleModelSelect = useCallback(
    (modelId: string) => {
      setIsPickingModel(false);
      server.setModel(modelId).then(() => {
        server.addSystemMessage(`Model set to ${modelId}.`);
      });
    },
    [server],
  );

  const handleModelReset = useCallback(() => {
    setIsPickingModel(false);
    server.setModel(null).then(() => {
      server.addSystemMessage("Model reset to server default.");
    });
  }, [server]);

  const handleModelPickerCancel = useCallback(() => {
    setIsPickingModel(false);
  }, []);

  const handleKeyRevoke = useCallback(
    async (id: string) => {
      const { revoked } = await server.revokeApiKey(id);
      server.addSystemMessage(revoked ? "Key revoked." : "Key was already revoked.");
    },
    [server],
  );

  const handleKeysPickerCancel = useCallback(() => {
    setIsPickingKeys(false);
  }, []);

  if (workspacePickerLevel !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <WorkspacePicker
          listWorkspaces={server.listWorkspaces}
          listWorkspaceSessions={server.listWorkspaceSessions}
          onSelectSession={handleWorkspaceSessionSelect}
          onCreateWorkspace={handleWorkspaceCreate}
          onRenameWorkspace={handleWorkspaceRename}
          onCancel={handleWorkspacePickerCancel}
          currentWorkspaceId={server.workspaceId}
          currentSessionId={server.sessionId}
          workerName={server.workerName}
          initialLevel={workspacePickerLevel}
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

  if (isPickingModel) {
    return (
      <Box flexDirection="column" padding={1}>
        <ModelPicker
          listModels={server.listModels}
          onSelect={handleModelSelect}
          onReset={handleModelReset}
          onCancel={handleModelPickerCancel}
          currentModel={server.currentModel}
        />
      </Box>
    );
  }

  if (isPickingKeys) {
    return (
      <Box flexDirection="column" padding={1}>
        <KeyPicker
          listApiKeys={server.listApiKeys}
          onRevoke={handleKeyRevoke}
          onCancel={handleKeysPickerCancel}
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
          {server.workspaceName ? ` ${server.workspaceName}` : ""}
          {" "}
          (Esc to {isBusy ? "abort" : "exit"}, Ctrl+L new session, /help for commands)
        </Text>
      </Box>

      <ChatHistory key={server.sessionId} messages={server.messages} completedToolCalls={server.completedToolCalls} />

      <ToolCallDisplay toolCalls={server.activeToolCalls} filterTask />

      <SubagentBlock subagents={server.activeSubagents} />

      <StreamingResponse content={server.streamingContent} visible={isBusy} />

      <StatusBar status={server.status} shellRunning={server.isShellRunning} />

      {server.cronNotification && (
        <Box marginBottom={1}>
          <Text color="yellow">
            {server.cronNotification.error
              ? `Cron failed: ${server.cronNotification.jobName} — ${server.cronNotification.error}`
              : `Cron: ${server.cronNotification.jobName} fired`}
            {" "}
          </Text>
          <Text dimColor>(type /workspace to switch sessions)</Text>
        </Box>
      )}

      {server.pendingApprovals.length > 0 && (
        <ToolApprovalPrompt
          approvals={server.pendingApprovals}
          onApprove={server.approveToolCall}
          onAlwaysApprove={server.alwaysApproveToolCall}
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
        disabled={isBusy || hasApprovals}
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
