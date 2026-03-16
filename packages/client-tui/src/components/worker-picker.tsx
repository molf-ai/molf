import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { WorkerInfo } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading, PickerEmpty } from "./picker-states.js";

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

  usePickerInput({
    list,
    onEscape: onCancel,
    onEnter: () => {
      if (workers && workers.length > 0) {
        const selected = workers[list.selectedIndex];
        if (selected.connected) onSelect(selected.workerId);
      }
    },
  });

  if (workers === null) return <PickerLoading>Loading workers...</PickerLoading>;
  if (workers.length === 0) return <PickerEmpty>No workers connected.</PickerEmpty>;

  const visibleWorkers = workers.slice(list.visibleStart, list.visibleEnd);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Workers</Text>
        <Text dimColor> (↑↓ navigate, Enter select, Esc cancel)</Text>
      </Box>

      <ScrollHints hiddenAbove={list.hiddenAbove} hiddenBelow={list.hiddenBelow}>
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
      </ScrollHints>
    </Box>
  );
}
