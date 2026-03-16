import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ClientOptions } from "ws";
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
import { ProviderPicker } from "./components/provider-picker.js";
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
  providersCommand,
  editorCommand,
} from "./commands/index.js";
import type { CommandContext } from "./commands/index.js";
import { useExternalEditor } from "./hooks/use-external-editor.js";

export interface AppProps {
  serverUrl: string;
  token: string;
  sessionId?: string;
  workerId?: string;
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
}

type ModalState =
  | { kind: "none" }
  | { kind: "workspace"; level: "workspaces" | "sessions" }
  | { kind: "worker" }
  | { kind: "model" }
  | { kind: "keys" }
  | { kind: "provider" };

export function App({ serverUrl, token, sessionId, workerId, tlsOpts }: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const { write: writeStdout } = useStdout();
  const prevPickingRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);

  const server = useServer({ url: serverUrl, token, sessionId, workerId, tlsOpts });

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

  const isPicking = modal.kind !== "none";
  const closeModal = useCallback(() => setModal({ kind: "none" }), []);

  // Clear terminal when entering/leaving picker modals so Static output doesn't linger
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
    reg.register(providersCommand);
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
      enterSessionPicker: () => setModal({ kind: "workspace", level: "sessions" }),
      enterWorkerPicker: () => setModal({ kind: "worker" }),
      enterModelPicker: () => setModal({ kind: "model" }),
      enterWorkspacePicker: () => setModal({ kind: "workspace", level: "workspaces" }),
      renameSession: server.renameSession,
      createWorkspace: server.createWorkspace,
      renameWorkspace: server.renameWorkspace,
      openEditor: editor.openEditor,
      createPairingCode: server.createPairingCode,
      enterKeysPicker: () => setModal({ kind: "keys" }),
      enterProviderPicker: () => setModal({ kind: "provider" }),
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
    if (isPicking || editor.isEditing || hasApprovals) return;

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
      closeModal();
      server.switchWorkspace(workspaceId, sessionId);
    },
    [server, closeModal],
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

  const handleWorkerSelect = useCallback(
    (selectedWorkerId: string) => {
      closeModal();
      server.switchWorker(selectedWorkerId);
    },
    [server, closeModal],
  );

  const handleModelSelect = useCallback(
    (modelId: string) => {
      closeModal();
      server.setModel(modelId).then(() => {
        server.addSystemMessage(`Model set to ${modelId}.`);
      });
    },
    [server, closeModal],
  );

  const handleModelReset = useCallback(() => {
    closeModal();
    server.setModel(null).then(() => {
      server.addSystemMessage("Model reset to server default.");
    });
  }, [server, closeModal]);

  const handleKeyRevoke = useCallback(
    async (id: string) => {
      const { revoked } = await server.revokeApiKey(id);
      server.addSystemMessage(revoked ? "Key revoked." : "Key was already revoked.");
    },
    [server],
  );

  const handleProviderPickerDone = useCallback((message?: string) => {
    closeModal();
    server.clearProviderSetupFlag();
    if (message) server.addSystemMessage(message);
  }, [server, closeModal]);

  // Show hint instead of auto-opening picker (auto-open caused OOM with large provider lists)
  useEffect(() => {
    if (server.needsProviderSetup) {
      server.addSystemMessage("No LLM providers configured. Run /providers to set up API keys.");
    }
  }, [server.needsProviderSetup]);

  switch (modal.kind) {
    case "workspace":
      return (
        <Box flexDirection="column" padding={1}>
          <WorkspacePicker
            listWorkspaces={server.listWorkspaces}
            listWorkspaceSessions={server.listWorkspaceSessions}
            onSelectSession={handleWorkspaceSessionSelect}
            onCreateWorkspace={handleWorkspaceCreate}
            onRenameWorkspace={handleWorkspaceRename}
            onCancel={closeModal}
            currentWorkspaceId={server.workspaceId}
            currentSessionId={server.sessionId}
            workerName={server.workerName}
            initialLevel={modal.level}
          />
        </Box>
      );

    case "worker":
      return (
        <Box flexDirection="column" padding={1}>
          <WorkerPicker
            listWorkers={server.listWorkers}
            onSelect={handleWorkerSelect}
            onCancel={closeModal}
            currentWorkerId={server.workerId}
          />
        </Box>
      );

    case "provider":
      return (
        <Box flexDirection="column" padding={1}>
          <ProviderPicker
            listProviders={server.listProviders}
            listModels={server.listModels}
            setProviderKey={server.setProviderKey}
            removeProviderKey={server.removeProviderKey}
            setDefaultModel={server.setDefaultModel}
            onCancel={closeModal}
            onDone={handleProviderPickerDone}
          />
        </Box>
      );

    case "model":
      return (
        <Box flexDirection="column" padding={1}>
          <ModelPicker
            listModels={server.listModels}
            listProviders={server.listProviders}
            onSelect={handleModelSelect}
            onReset={handleModelReset}
            onCancel={closeModal}
            currentModel={server.currentModel}
          />
        </Box>
      );

    case "keys":
      return (
        <Box flexDirection="column" padding={1}>
          <KeyPicker
            listApiKeys={server.listApiKeys}
            onRevoke={handleKeyRevoke}
            onCancel={closeModal}
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
