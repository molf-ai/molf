import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { TextArea } from "./text-area.js";
import type { SessionListItem } from "@molf-ai/protocol";

interface Props {
  listSessions: () => Promise<SessionListItem[]>;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  currentSessionId: string | null;
}

export function SessionPicker({ listSessions, onSelect, onCancel, currentSessionId }: Props) {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    listSessions().then(setSessions);
  }, [listSessions]);

  const filtered = sessions
    ? sessions.filter((s) =>
        s.name.toLowerCase().includes(search.toLowerCase()),
      )
    : [];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return && filtered.length > 0) {
      onSelect(filtered[selectedIndex].sessionId);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev >= filtered.length - 1 ? 0 : prev + 1));
      return;
    }
  });

  if (sessions === null) {
    return (
      <Box>
        <Text color="yellow">Loading sessions...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No sessions found. Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Sessions</Text>
        <Text dimColor> (arrows to navigate, Enter to select, Escape to cancel)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="cyan">{"Search: "}</Text>
        <TextArea
          value={search}
          onChange={(val) => { setSearch(val); setSelectedIndex(0); }}
          onSubmit={() => { if (filtered.length > 0) onSelect(filtered[selectedIndex].sessionId); }}
          suppressUpDown
          placeholder="Filter sessions..."
        />
      </Box>

      {filtered.length === 0 ? (
        <Text dimColor>No matching sessions.</Text>
      ) : (
        <Box flexDirection="column">
          {filtered.map((session, i) => {
            const isSelected = i === selectedIndex;
            const isCurrent = session.sessionId === currentSessionId;
            const date = new Date(session.lastActiveAt).toLocaleString();
            const preview = session.lastMessage
              ? session.lastMessage.length > 60
                ? session.lastMessage.slice(0, 60) + "..."
                : session.lastMessage
              : "";
            return (
              <Box key={session.sessionId} flexDirection="column" marginBottom={isSelected ? 1 : 0}>
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? "> " : "  "}
                    {session.name}
                  </Text>
                  <Text dimColor>
                    {" "}({session.messageCount} messages, {date})
                  </Text>
                  {isCurrent && <Text color="green"> [current]</Text>}
                  {session.active && !isCurrent && <Text color="yellow"> [active]</Text>}
                </Box>
                {isSelected && preview && (
                  <Box marginLeft={4}>
                    <Text dimColor wrap="truncate-end">{preview}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
