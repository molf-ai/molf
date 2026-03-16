import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TextArea } from "./text-area.js";
import type { SessionListItem } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading, PickerEmpty } from "./picker-states.js";

interface Props {
  listSessions: () => Promise<SessionListItem[]>;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  currentSessionId: string | null;
}

export function SessionPicker({ listSessions, onSelect, onCancel, currentSessionId }: Props) {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    listSessions().then(setSessions);
  }, [listSessions]);

  const filtered = sessions
    ? sessions.filter((s) =>
        s.name.toLowerCase().includes(search.toLowerCase()),
      )
    : [];

  const list = useScrollableList({ itemCount: filtered.length, reservedRows: 8 });

  usePickerInput({
    list,
    onEscape: () => {
      if (search) { setSearch(""); list.setSelectedIndex(0); }
      else onCancel();
    },
    onEnter: () => {
      if (filtered.length > 0) onSelect(filtered[list.selectedIndex].sessionId);
    },
  });

  if (sessions === null) return <PickerLoading>Loading sessions...</PickerLoading>;
  if (sessions.length === 0) return <PickerEmpty>No sessions found.</PickerEmpty>;

  const visibleSessions = filtered.slice(list.visibleStart, list.visibleEnd);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Sessions</Text>
        <Text dimColor> (↑↓ navigate, Enter select, Esc cancel)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="cyan">{"Search: "}</Text>
        <TextArea
          value={search}
          onChange={(val) => { setSearch(val); list.setSelectedIndex(0); }}
          onSubmit={() => { if (filtered.length > 0) onSelect(filtered[list.selectedIndex].sessionId); }}
          suppressUpDown
          placeholder="Filter sessions..."
        />
      </Box>

      {filtered.length === 0 ? (
        <Text dimColor>No matching sessions.</Text>
      ) : (
        <ScrollHints hiddenAbove={list.hiddenAbove} hiddenBelow={list.hiddenBelow}>
          <Box flexDirection="column" minHeight={list.viewportSize}>
            {visibleSessions.map((session, vi) => {
              const realIdx = list.visibleStart + vi;
              const isSelected = realIdx === list.selectedIndex;
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
        </ScrollHints>
      )}
    </Box>
  );
}
