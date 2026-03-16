import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { TextArea } from "./text-area.js";
import type { Workspace } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading, PickerEmpty } from "./picker-states.js";

export interface WorkspaceSessionInfo {
  sessionId: string;
  name: string;
  messageCount: number;
  lastActiveAt: number;
  isLastSession: boolean;
}

interface Props {
  listWorkspaces: () => Promise<Workspace[]>;
  listWorkspaceSessions: (workspaceId: string) => Promise<WorkspaceSessionInfo[]>;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  onCancel: () => void;
  currentWorkspaceId: string | null;
  currentSessionId: string | null;
  workerName: string | null;
  initialLevel?: "workspaces" | "sessions";
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function WorkspacePicker({
  listWorkspaces,
  listWorkspaceSessions,
  onSelectSession,
  onCreateWorkspace,
  onRenameWorkspace,
  onCancel,
  currentWorkspaceId,
  currentSessionId,
  workerName,
  initialLevel,
}: Props) {
  const [level, setLevel] = useState<"workspaces" | "sessions">(initialLevel ?? "workspaces");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionInfo[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [inlineMode, setInlineMode] = useState<null | "new" | "rename">(null);
  const [inlineValue, setInlineValue] = useState("");
  const enteredDirectly = useRef(initialLevel === "sessions");

  // Load workspaces on mount
  useEffect(() => {
    listWorkspaces().then((wss) => {
      setWorkspaces(wss);
      // If entering directly at sessions level, find the current workspace
      if (initialLevel === "sessions" && currentWorkspaceId) {
        const ws = wss.find((w) => w.id === currentWorkspaceId);
        if (ws) {
          setSelectedWorkspace(ws);
          listWorkspaceSessions(ws.id).then(setSessions);
        }
      }
    });
  }, [listWorkspaces, listWorkspaceSessions, initialLevel, currentWorkspaceId]);

  const filteredWorkspaces = workspaces
    ? workspaces.filter((w) => w.name.toLowerCase().includes(search.toLowerCase()))
    : [];

  const filteredSessions = sessions
    ? sessions.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : [];

  const workspaceList = useScrollableList({
    itemCount: filteredWorkspaces.length,
    reservedRows: 8,
  });

  const sessionList = useScrollableList({
    itemCount: filteredSessions.length,
    reservedRows: 8,
  });

  const drillIntoWorkspace = (ws: Workspace) => {
    setSelectedWorkspace(ws);
    setSessions(null);
    setSearch("");
    sessionList.setSelectedIndex(0);
    setLevel("sessions");
    listWorkspaceSessions(ws.id).then(setSessions);
  };

  // Workspace-level input
  usePickerInput({
    list: workspaceList,
    isActive: level === "workspaces" && !inlineMode,
    onEscape: onCancel,
    onEnter: () => {
      if (filteredWorkspaces.length > 0) {
        drillIntoWorkspace(filteredWorkspaces[workspaceList.selectedIndex]);
      }
    },
    onKey: (input, key) => {
      if (key.ctrl && input === "n") {
        setInlineMode("new");
        setInlineValue("");
        return true;
      }
      if (key.ctrl && input === "r" && filteredWorkspaces.length > 0) {
        setInlineMode("rename");
        setInlineValue(filteredWorkspaces[workspaceList.selectedIndex].name);
        return true;
      }
    },
  });

  // Session-level input
  usePickerInput({
    list: sessionList,
    isActive: level === "sessions" && !inlineMode,
    onEscape: () => {
      if (search) {
        setSearch("");
        sessionList.setSelectedIndex(0);
      } else if (enteredDirectly.current) {
        onCancel();
      } else {
        setLevel("workspaces");
        setSessions(null);
        setSearch("");
        workspaceList.setSelectedIndex(0);
      }
    },
    onEnter: () => {
      if (filteredSessions.length > 0 && selectedWorkspace) {
        onSelectSession(selectedWorkspace.id, filteredSessions[sessionList.selectedIndex].sessionId);
      }
    },
  });

  // Inline mode: Escape cancels the inline edit
  useInput((_input, key) => {
    if (inlineMode && key.escape) handleInlineCancel();
  });

  const [inlineError, setInlineError] = useState<string | null>(null);

  const handleInlineSubmit = async () => {
    const value = inlineValue.trim();
    if (!value) {
      setInlineMode(null);
      return;
    }

    try {
      setInlineError(null);
      if (inlineMode === "new") {
        await onCreateWorkspace(value);
        const wss = await listWorkspaces();
        setWorkspaces(wss);
      } else if (inlineMode === "rename" && filteredWorkspaces.length > 0) {
        const ws = filteredWorkspaces[workspaceList.selectedIndex];
        await onRenameWorkspace(ws.id, value);
        const wss = await listWorkspaces();
        setWorkspaces(wss);
      }
      setInlineMode(null);
      setInlineValue("");
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : "Operation failed");
    }
  };

  const handleInlineCancel = () => {
    setInlineMode(null);
    setInlineValue("");
    setInlineError(null);
  };

  // Loading state
  if (workspaces === null) return <PickerLoading>Loading workspaces...</PickerLoading>;

  // Level 2: Session list
  if (level === "sessions") {
    if (sessions === null) return <PickerLoading>Loading sessions...</PickerLoading>;

    const visibleSessions = filteredSessions.slice(sessionList.visibleStart, sessionList.visibleEnd);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="magenta">{selectedWorkspace?.name ?? "Sessions"}</Text>
          <Text dimColor> ({sessions.length} session{sessions.length !== 1 ? "s" : ""})</Text>
          <Text dimColor>  [Esc] {enteredDirectly.current ? "Cancel" : "Back"}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text bold color="cyan">{"Filter: "}</Text>
          <TextArea
            value={search}
            onChange={(val) => { setSearch(val); sessionList.setSelectedIndex(0); }}
            onSubmit={() => {
              if (filteredSessions.length > 0 && selectedWorkspace) {
                onSelectSession(selectedWorkspace.id, filteredSessions[sessionList.selectedIndex].sessionId);
              }
            }}
            suppressUpDown
            placeholder="Filter sessions..."
          />
        </Box>

        {filteredSessions.length === 0 ? (
          <Text dimColor>No matching sessions.</Text>
        ) : (
          <ScrollHints hiddenAbove={sessionList.hiddenAbove} hiddenBelow={sessionList.hiddenBelow}>
            <Box flexDirection="column" minHeight={sessionList.viewportSize}>
              {visibleSessions.map((session, vi) => {
                const realIdx = sessionList.visibleStart + vi;
                const isSelected = realIdx === sessionList.selectedIndex;
                const isHere = selectedWorkspace?.id === currentWorkspaceId && session.sessionId === currentSessionId;
                const isRecommended = session.isLastSession && !isHere;
                const time = relativeTime(session.lastActiveAt);
                return (
                  <Box key={session.sessionId} marginBottom={isSelected ? 1 : 0}>
                    <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                      {isSelected ? "> " : "  "}
                      {session.name}
                    </Text>
                    <Text dimColor>
                      {" "}({session.messageCount} messages, {time})
                    </Text>
                    {isHere && <Text color="green"> [you are here]</Text>}
                    {isRecommended && <Text color="cyan"> [recommended]</Text>}
                  </Box>
                );
              })}
            </Box>
          </ScrollHints>
        )}

        <Box marginTop={1}>
          <Text dimColor>[Enter] Switch session  [Esc] {enteredDirectly.current ? "Cancel" : "Back to workspaces"}</Text>
        </Box>
      </Box>
    );
  }

  // Level 1: Workspace list
  if (workspaces.length === 0) return <PickerEmpty>No workspaces found.</PickerEmpty>;

  const visibleWorkspaces = filteredWorkspaces.slice(workspaceList.visibleStart, workspaceList.visibleEnd);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Workspaces</Text>
        {workerName && <Text dimColor> ({workerName})</Text>}
        <Text dimColor>  [Esc] Cancel</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="cyan">{"Filter: "}</Text>
        <TextArea
          value={search}
          onChange={(val) => { setSearch(val); workspaceList.setSelectedIndex(0); }}
          onSubmit={() => {
            if (filteredWorkspaces.length > 0) {
              drillIntoWorkspace(filteredWorkspaces[workspaceList.selectedIndex]);
            }
          }}
          suppressUpDown
          placeholder="Filter workspaces..."
        />
      </Box>

      {inlineMode && (
        <Box marginBottom={1}>
          <Text bold color="yellow">
            {inlineMode === "new" ? "New workspace name: " : "Rename to: "}
          </Text>
          <TextArea
            value={inlineValue}
            onChange={setInlineValue}
            onSubmit={handleInlineSubmit}
            placeholder={inlineMode === "new" ? "workspace name..." : "new name..."}
          />
          <Text dimColor> (Enter to confirm, Esc to cancel)</Text>
        </Box>
      )}

      {inlineError && (
        <Box marginBottom={1}>
          <Text color="red">{inlineError}</Text>
        </Box>
      )}

      {filteredWorkspaces.length === 0 ? (
        <Text dimColor>No matching workspaces.</Text>
      ) : (
        <ScrollHints hiddenAbove={workspaceList.hiddenAbove} hiddenBelow={workspaceList.hiddenBelow}>
          <Box flexDirection="column" minHeight={workspaceList.viewportSize}>
            {visibleWorkspaces.map((ws, vi) => {
              const realIdx = workspaceList.visibleStart + vi;
              const isSelected = realIdx === workspaceList.selectedIndex;
              const isCurrent = ws.id === currentWorkspaceId;
              return (
                <Box key={ws.id} marginBottom={isSelected ? 1 : 0}>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? "> " : "  "}
                    {ws.name}
                  </Text>
                  <Text dimColor>
                    {" "}({ws.sessions.length} session{ws.sessions.length !== 1 ? "s" : ""})
                  </Text>
                  {isCurrent && <Text color="green"> [current]</Text>}
                </Box>
              );
            })}
          </Box>
        </ScrollHints>
      )}

      <Box marginTop={1}>
        <Text dimColor>[Enter] Open  [Ctrl+N] New  [Ctrl+R] Rename  [Esc] Cancel</Text>
      </Box>
    </Box>
  );
}
