import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ModelInfo } from "@molf-ai/protocol";

interface Props {
  listModels: () => Promise<ModelInfo[]>;
  onSelect: (modelId: string) => void;
  onReset: () => void;
  onCancel: () => void;
  currentModel: string | null;
}

export function ModelPicker({ listModels, onSelect, onReset, onCancel, currentModel }: Props) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    listModels().then(setModels);
  }, [listModels]);

  // +1 for the "Default (server)" option at index 0
  const totalItems = models ? models.length + 1 : 1;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return && models) {
      if (selectedIndex === 0) {
        onReset();
      } else {
        const selected = models[selectedIndex - 1];
        onSelect(selected.id);
      }
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev <= 0 ? totalItems - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev >= totalItems - 1 ? 0 : prev + 1));
      return;
    }
  });

  if (models === null) {
    return (
      <Box>
        <Text color="yellow">Loading models...</Text>
      </Box>
    );
  }

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No models available. Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">Models</Text>
        <Text dimColor> (arrows to navigate, Enter to select, Escape to cancel)</Text>
      </Box>

      <Box flexDirection="column">
        {/* Default/reset option */}
        <Box key="__default" marginBottom={selectedIndex === 0 ? 1 : 0}>
          <Text color={selectedIndex === 0 ? "cyan" : undefined} bold={selectedIndex === 0}>
            {selectedIndex === 0 ? "> " : "  "}
            Default (server)
          </Text>
          {!currentModel && <Text color="green"> [current]</Text>}
        </Box>

        {models.map((model, i) => {
          const idx = i + 1;
          const isSelected = idx === selectedIndex;
          const isCurrent = model.id === currentModel;
          return (
            <Box key={model.id} marginBottom={isSelected ? 1 : 0}>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "> " : "  "}
                {model.name}
              </Text>
              <Text dimColor> ({model.providerID})</Text>
              {isCurrent && <Text color="green"> [current]</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
