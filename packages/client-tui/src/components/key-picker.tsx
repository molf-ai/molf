import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading, PickerEmpty } from "./picker-states.js";

interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

interface Props {
  listApiKeys: () => Promise<ApiKeyInfo[]>;
  onRevoke: (id: string) => Promise<void>;
  onCancel: () => void;
}

export function KeyPicker({ listApiKeys, onRevoke, onCancel }: Props) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [revoking, setRevoking] = useState(false);
  const list = useScrollableList({ itemCount: keys?.length ?? 0, reservedRows: 6 });

  const fetchKeys = () => {
    listApiKeys().then(setKeys);
  };

  useEffect(() => {
    fetchKeys();
  }, [listApiKeys]);

  usePickerInput({
    list,
    onEscape: onCancel,
    onKey: (input, key) => {
      if (revoking) return true;
      // Ctrl+R or Delete to revoke
      if ((key.ctrl && input === "r") || key.delete) {
        if (!keys || keys.length === 0) return true;
        const selected = keys[list.selectedIndex];
        if (selected.revokedAt) return true;

        setRevoking(true);
        onRevoke(selected.id).then(() => {
          setRevoking(false);
          fetchKeys();
        });
        return true;
      }
    },
  });

  if (keys === null) return <PickerLoading>Loading API keys...</PickerLoading>;
  if (keys.length === 0) return <PickerEmpty>No API keys.</PickerEmpty>;

  const visibleKeys = keys.slice(list.visibleStart, list.visibleEnd);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">API Keys</Text>
        <Text dimColor> (↑↓ navigate, Ctrl+R revoke, Esc cancel)</Text>
      </Box>

      <ScrollHints hiddenAbove={list.hiddenAbove} hiddenBelow={list.hiddenBelow}>
        <Box flexDirection="column">
          {visibleKeys.map((k, vi) => {
            const realIdx = list.visibleStart + vi;
            const isSelected = realIdx === list.selectedIndex;
            const isRevoked = k.revokedAt !== null;
            const created = new Date(k.createdAt).toISOString().slice(0, 10);
            return (
              <Box key={k.id} marginBottom={isSelected ? 1 : 0}>
                <Text
                  color={isRevoked ? undefined : isSelected ? "cyan" : undefined}
                  bold={isSelected}
                  dimColor={isRevoked}
                >
                  {isSelected ? "> " : "  "}
                  {k.name}
                </Text>
                <Text dimColor> {created}</Text>
                {isRevoked ? (
                  <Text color="red" dimColor> [revoked]</Text>
                ) : (
                  <Text color="green"> [active]</Text>
                )}
              </Box>
            );
          })}
        </Box>
      </ScrollHints>

      {revoking && (
        <Box marginTop={1}>
          <Text color="yellow">Revoking...</Text>
        </Box>
      )}
    </Box>
  );
}
