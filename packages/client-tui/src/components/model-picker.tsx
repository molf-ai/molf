import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ModelInfo, ProviderListItem } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";

interface Props {
  listModels: (providerID: string) => Promise<ModelInfo[]>;
  listProviders: () => Promise<ProviderListItem[]>;
  onSelect: (modelId: string) => void;
  onReset: () => void;
  onCancel: () => void;
  currentModel: string | null;
  /** If set, skip provider selection and show this provider's models directly. */
  initialProviderID?: string;
}

type Level = "providers" | "models";

export function ModelPicker({
  listModels,
  listProviders,
  onSelect,
  onReset,
  onCancel,
  currentModel,
  initialProviderID,
}: Props) {
  const [level, setLevel] = useState<Level>(initialProviderID ? "models" : "providers");
  const [providers, setProviders] = useState<ProviderListItem[] | null>(null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [selectedProviderID, setSelectedProviderID] = useState<string | null>(initialProviderID ?? null);

  // Only providers with keys
  const activeProviders = providers?.filter((p) => p.hasKey) ?? [];

  // +1 for "Default (server)"
  const providerList = useScrollableList({ itemCount: activeProviders.length + 1, reservedRows: 6 });
  const modelListHook = useScrollableList({ itemCount: models?.length ?? 0, reservedRows: 6 });

  // Fetch providers on mount
  useEffect(() => {
    listProviders().then(setProviders);
  }, [listProviders]);

  // Fetch models for a provider (called imperatively, not from useEffect)
  const loadModelsRef = React.useRef((providerID: string) => {
    setModels(null);
    setSelectedProviderID(providerID);
    setLevel("models");
    modelListHook.setSelectedIndex(0);
    listModels(providerID).then(setModels);
  });
  loadModelsRef.current = (providerID: string) => {
    setModels(null);
    setSelectedProviderID(providerID);
    setLevel("models");
    modelListHook.setSelectedIndex(0);
    listModels(providerID).then(setModels);
  };

  // If initialProviderID, load models once (on mount only)
  const didInitRef = React.useRef(false);
  useEffect(() => {
    if (initialProviderID && providers && !didInitRef.current) {
      didInitRef.current = true;
      loadModelsRef.current(initialProviderID);
    }
  }, [initialProviderID, providers]);

  useInput((input, key) => {
    if (level === "providers") {
      if (key.escape) { onCancel(); return; }
      if (key.upArrow) { providerList.moveUp(); return; }
      if (key.downArrow) { providerList.moveDown(); return; }
      if (key.return) {
        if (providerList.selectedIndex === 0) {
          onReset();
        } else {
          const provider = activeProviders[providerList.selectedIndex - 1];
          if (provider) loadModelsRef.current(provider.id);
        }
        return;
      }
    }

    if (level === "models") {
      if (key.escape) {
        if (initialProviderID) onCancel();
        else { setLevel("providers"); setModels(null); }
        return;
      }
      if (!models || models.length === 0) return;
      if (key.upArrow) { modelListHook.moveUp(); return; }
      if (key.downArrow) { modelListHook.moveDown(); return; }
      if (key.return) {
        onSelect(models[modelListHook.selectedIndex].id);
        return;
      }
    }
  });

  // Loading
  if (providers === null) {
    return <Box><Text color="yellow">Loading...</Text></Box>;
  }

  if (activeProviders.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No providers with API keys. Run /providers first.</Text>
        <Text dimColor>Press Escape to go back.</Text>
      </Box>
    );
  }

  // Provider level
  if (level === "providers") {
    const items = [
      { key: "__default", idx: 0 },
      ...activeProviders.map((p, i) => ({ key: p.id, idx: i + 1 })),
    ];
    const visible = items.slice(providerList.visibleStart, providerList.visibleEnd);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="magenta">Select Provider</Text>
          <Text dimColor> (Enter to browse models, Escape to cancel)</Text>
        </Box>

        {providerList.hiddenAbove > 0 && <Text dimColor>  ↑ {providerList.hiddenAbove} more</Text>}

        <Box flexDirection="column">
          {visible.map(({ key, idx }) => {
            const isSelected = idx === providerList.selectedIndex;
            if (idx === 0) {
              return (
                <Box key={key}>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? "> " : "  "}Default (server)
                  </Text>
                  {!currentModel && <Text color="green"> [current]</Text>}
                </Box>
              );
            }
            const p = activeProviders[idx - 1];
            const isCurrent = currentModel?.startsWith(p.id + "/");
            return (
              <Box key={key}>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? "> " : "  "}{p.name}
                </Text>
                <Text dimColor> ({p.modelCount} models)</Text>
                {isCurrent && <Text color="green"> [current]</Text>}
              </Box>
            );
          })}
        </Box>

        {providerList.hiddenBelow > 0 && <Text dimColor>  ↓ {providerList.hiddenBelow} more</Text>}
      </Box>
    );
  }

  // Model level
  if (models === null) {
    return <Box><Text color="yellow">Loading models...</Text></Box>;
  }

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No models for this provider. Press Escape to go back.</Text>
      </Box>
    );
  }

  const visibleModels = models.slice(modelListHook.visibleStart, modelListHook.visibleEnd);
  const providerName = providers?.find((p) => p.id === selectedProviderID)?.name ?? selectedProviderID;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">{providerName}</Text>
        <Text dimColor> — select model (Enter to set, Escape to go back)</Text>
      </Box>

      {modelListHook.hiddenAbove > 0 && <Text dimColor>  ↑ {modelListHook.hiddenAbove} more</Text>}

      <Box flexDirection="column">
        {visibleModels.map((model, vi) => {
          const realIdx = modelListHook.visibleStart + vi;
          const isSelected = realIdx === modelListHook.selectedIndex;
          const isCurrent = model.id === currentModel;
          return (
            <Box key={model.id}>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "> " : "  "}{model.name}
              </Text>
              {isCurrent && <Text color="green"> [current]</Text>}
            </Box>
          );
        })}
      </Box>

      {modelListHook.hiddenBelow > 0 && <Text dimColor>  ↓ {modelListHook.hiddenBelow} more</Text>}
    </Box>
  );
}
