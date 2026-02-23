import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { WorkerInfo } from "@molf-ai/protocol";

interface Props {
  listWorkers: () => Promise<WorkerInfo[]>;
  onSelect: (workerId: string) => void;
  onCancel: () => void;
  currentWorkerId: string | null;
}

export function WorkerPicker({ listWorkers, onSelect, onCancel, currentWorkerId }: Props) {
  const [workers, setWorkers] = useState<WorkerInfo[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    listWorkers().then(setWorkers);
  }, [listWorkers]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return && workers && workers.length > 0) {
      const selected = workers[selectedIndex];
      if (selected.connected) {
        onSelect(selected.workerId);
      }
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev <= 0 ? (workers?.length ?? 1) - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev >= (workers?.length ?? 1) - 1 ? 0 : prev + 1));
      return;
    }
  });

  if (workers === null) {
    return (
      <Box>
        <Text color="yellow">Loading workers...</Text>
      </Box>
    );
  }

  if (workers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No workers connected. Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Workers</Text>
        <Text dimColor> (arrows to navigate, Enter to select, Escape to cancel)</Text>
      </Box>

      <Box flexDirection="column">
        {workers.map((worker, i) => {
          const isSelected = i === selectedIndex;
          const isCurrent = worker.workerId === currentWorkerId;
          const isOffline = !worker.connected;
          return (
            <Box key={worker.workerId} marginBottom={isSelected ? 1 : 0}>
              <Text color={isOffline ? undefined : isSelected ? "cyan" : undefined} bold={isSelected} dimColor={isOffline}>
                {isSelected ? "> " : "  "}
                {worker.name}
              </Text>
              <Text dimColor>
                {" "}({worker.tools.length} tools)
              </Text>
              {isOffline && <Text color="red" dimColor> [offline]</Text>}
              {isCurrent && <Text color="green"> [current]</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
