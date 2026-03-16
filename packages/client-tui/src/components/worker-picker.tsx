import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { WorkerInfo } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";

interface Props {
  listWorkers: () => Promise<WorkerInfo[]>;
  onSelect: (workerId: string) => void;
  onCancel: () => void;
  currentWorkerId: string | null;
}

export function WorkerPicker({ listWorkers, onSelect, onCancel, currentWorkerId }: Props) {
  const [workers, setWorkers] = useState<WorkerInfo[] | null>(null);
  const list = useScrollableList({ itemCount: workers?.length ?? 0, reservedRows: 6 });

  useEffect(() => {
    listWorkers().then(setWorkers);
  }, [listWorkers]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return && workers && workers.length > 0) {
      const selected = workers[list.selectedIndex];
      if (selected.connected) {
        onSelect(selected.workerId);
      }
      return;
    }
    if (key.upArrow) {
      list.moveUp();
      return;
    }
    if (key.downArrow) {
      list.moveDown();
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

  const visibleWorkers = workers.slice(list.visibleStart, list.visibleEnd);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Workers</Text>
        <Text dimColor> (arrows to navigate, Enter to select, Escape to cancel)</Text>
      </Box>

      {list.hiddenAbove > 0 && <Text dimColor>  ↑ {list.hiddenAbove} more</Text>}

      <Box flexDirection="column">
        {visibleWorkers.map((worker, vi) => {
          const realIdx = list.visibleStart + vi;
          const isSelected = realIdx === list.selectedIndex;
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

      {list.hiddenBelow > 0 && <Text dimColor>  ↓ {list.hiddenBelow} more</Text>}
    </Box>
  );
}
