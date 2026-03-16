import React, { useState, useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import type { ModelInfo, ProviderListItem } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading, PickerEmpty } from "./picker-states.js";
import { isTextInput } from "../keys.js";

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
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");

  // Only providers with keys, filtered by search
  const activeProviders = useMemo(() => {
    const keyed = providers?.filter((p) => p.hasKey) ?? [];
    if (!providerSearch) return keyed;
    const q = providerSearch.toLowerCase();
    return keyed.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [providers, providerSearch]);

  const filteredModels = useMemo(() => {
    if (!models) return null;
    if (!modelSearch) return models;
    const q = modelSearch.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, modelSearch]);

  // +1 for "Default (server)" only when not searching
  const providerList = useScrollableList({ itemCount: activeProviders.length + (providerSearch ? 0 : 1), reservedRows: 8 });
  const modelListHook = useScrollableList({ itemCount: filteredModels?.length ?? 0, reservedRows: 8 });

  // Fetch providers on mount
  useEffect(() => {
    listProviders().then(setProviders);
  }, [listProviders]);

  // Fetch models for a provider (called imperatively)
  const loadModelsRef = React.useRef((providerID: string) => {
    setModels(null);
    setModelSearch("");
    setSelectedProviderID(providerID);
    setLevel("models");
    modelListHook.setSelectedIndex(0);
    listModels(providerID).then(setModels);
  });
  loadModelsRef.current = (providerID: string) => {
    setModels(null);
    setModelSearch("");
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

  // Provider-level input
  usePickerInput({
    list: providerList,
    isActive: level === "providers",
    onEscape: () => {
      if (providerSearch) { setProviderSearch(""); providerList.setSelectedIndex(0); }
      else onCancel();
    },
    onEnter: () => {
      if (!providerSearch && providerList.selectedIndex === 0) {
        onReset();
      } else {
        const offset = providerSearch ? 0 : 1;
        const provider = activeProviders[providerList.selectedIndex - offset];
        if (provider) loadModelsRef.current(provider.id);
      }
    },
    onKey: (input, key) => {
      if (key.backspace || key.delete) {
        if (providerSearch) {
          setProviderSearch((prev) => prev.slice(0, -1));
          providerList.setSelectedIndex(0);
        }
        return true;
      }
      if (isTextInput(input, key)) {
        setProviderSearch((prev) => prev + input);
        providerList.setSelectedIndex(0);
        return true;
      }
    },
  });

  // Model-level input
  usePickerInput({
    list: modelListHook,
    isActive: level === "models",
    onEscape: () => {
      if (modelSearch) { setModelSearch(""); modelListHook.setSelectedIndex(0); }
      else if (initialProviderID) onCancel();
      else { setLevel("providers"); setModels(null); setModelSearch(""); }
    },
    onEnter: () => {
      if (filteredModels && filteredModels.length > 0) {
        onSelect(filteredModels[modelListHook.selectedIndex].id);
      }
    },
    onKey: (input, key) => {
      if (key.backspace || key.delete) {
        if (modelSearch) {
          setModelSearch((prev) => prev.slice(0, -1));
          modelListHook.setSelectedIndex(0);
        }
        return true;
      }
      if (isTextInput(input, key)) {
        setModelSearch((prev) => prev + input);
        modelListHook.setSelectedIndex(0);
        return true;
      }
    },
  });

  // Loading
  if (providers === null) return <PickerLoading />;

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
    const offset = providerSearch ? 0 : 1;
    const items = [
      ...(providerSearch ? [] : [{ key: "__default", idx: 0 }]),
      ...activeProviders.map((p, i) => ({ key: p.id, idx: i + offset })),
    ];
    const visible = items.slice(providerList.visibleStart, providerList.visibleEnd);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="magenta">Select Provider</Text>
          <Text dimColor> (↑↓ navigate, Enter select, Esc cancel)</Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Search: </Text>
          <Text>{providerSearch}</Text>
          <Text color="cyan">█</Text>
        </Box>

        {items.length === 0 && <Text dimColor>No providers match "{providerSearch}"</Text>}

        <ScrollHints hiddenAbove={providerList.hiddenAbove} hiddenBelow={providerList.hiddenBelow}>
          <Box flexDirection="column" minHeight={providerList.viewportSize}>
            {visible.map(({ key, idx }) => {
              const isSelected = idx === providerList.selectedIndex;
              if (key === "__default") {
                return (
                  <Box key={key}>
                    <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                      {isSelected ? "> " : "  "}Default (server)
                    </Text>
                    {!currentModel && <Text color="green"> [current]</Text>}
                  </Box>
                );
              }
              const p = activeProviders[idx - offset];
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
        </ScrollHints>
      </Box>
    );
  }

  // Model level
  if (models === null) return <PickerLoading>Loading models...</PickerLoading>;
  if (models.length === 0) return <PickerEmpty>No models for this provider.</PickerEmpty>;

  const visibleModels = (filteredModels ?? []).slice(modelListHook.visibleStart, modelListHook.visibleEnd);
  const providerName = providers?.find((p) => p.id === selectedProviderID)?.name ?? selectedProviderID;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">{providerName}</Text>
        <Text dimColor> — select model (↑↓ navigate, Enter select, Esc back)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Search: </Text>
        <Text>{modelSearch}</Text>
        <Text color="cyan">█</Text>
      </Box>

      {filteredModels?.length === 0 && <Text dimColor>No models match "{modelSearch}"</Text>}

      <ScrollHints hiddenAbove={modelListHook.hiddenAbove} hiddenBelow={modelListHook.hiddenBelow}>
        <Box flexDirection="column" minHeight={modelListHook.viewportSize}>
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
      </ScrollHints>
    </Box>
  );
}
