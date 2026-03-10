import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [revoking, setRevoking] = useState(false);

  const fetchKeys = () => {
    listApiKeys().then(setKeys);
  };

  useEffect(() => {
    fetchKeys();
  }, [listApiKeys]);

  useInput((input, key) => {
    if (revoking) return;

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev <= 0 ? (keys?.length ?? 1) - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev >= (keys?.length ?? 1) - 1 ? 0 : prev + 1));
      return;
    }
    // Ctrl+R or Delete to revoke
    if ((key.ctrl && input === "r") || key.delete) {
      if (!keys || keys.length === 0) return;
      const selected = keys[selectedIndex];
      if (selected.revokedAt) return; // already revoked

      setRevoking(true);
      onRevoke(selected.id).then(() => {
        setRevoking(false);
        fetchKeys();
      });
    }
  });

  if (keys === null) {
    return (
      <Box>
        <Text color="yellow">Loading API keys...</Text>
      </Box>
    );
  }

  if (keys.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No API keys. Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">API Keys</Text>
        <Text dimColor> (arrows to navigate, Ctrl+R to revoke, Escape to cancel)</Text>
      </Box>

      <Box flexDirection="column">
        {keys.map((k, i) => {
          const isSelected = i === selectedIndex;
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

      {revoking && (
        <Box marginTop={1}>
          <Text color="yellow">Revoking...</Text>
        </Box>
      )}
    </Box>
  );
}
