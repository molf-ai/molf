import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderListItem, ModelInfo } from "@molf-ai/protocol";
import { useScrollableList } from "../hooks/use-scrollable-list.js";
import { usePickerInput } from "../hooks/use-picker-input.js";
import { ScrollHints } from "./scroll-hints.js";
import { PickerLoading } from "./picker-states.js";
import { ModelPicker } from "./model-picker.js";
import { isTextInput } from "../keys.js";

interface Props {
  listProviders: () => Promise<ProviderListItem[]>;
  listModels: (providerID: string) => Promise<ModelInfo[]>;
  setProviderKey: (providerID: string, key: string) => Promise<void>;
  removeProviderKey: (providerID: string) => Promise<void>;
  setDefaultModel: (modelId: string) => Promise<void>;
  onCancel: () => void;
  onDone: (message?: string) => void;
}

type View = "providers" | "enter-key" | "pick-model";

const POPULAR_IDS = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "deepinfra",
];

type ListEntry =
  | { kind: "header"; label: string }
  | { kind: "provider"; provider: ProviderListItem };

function buildList(all: ProviderListItem[], filter: string): ListEntry[] {
  const q = filter.toLowerCase();
  const filtered = q
    ? all.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    : all;

  const popularSet = new Set(POPULAR_IDS);
  const popular: ProviderListItem[] = [];
  const configured: ProviderListItem[] = [];
  const other: ProviderListItem[] = [];

  for (const p of filtered) {
    if (popularSet.has(p.id)) popular.push(p);
    else if (!q && p.hasKey) configured.push(p);
    else other.push(p);
  }

  popular.sort((a, b) => POPULAR_IDS.indexOf(a.id) - POPULAR_IDS.indexOf(b.id));
  configured.sort((a, b) => a.name.localeCompare(b.name));
  other.sort((a, b) => a.name.localeCompare(b.name));

  const entries: ListEntry[] = [];

  if (popular.length > 0) {
    entries.push({ kind: "header", label: "Popular" });
    for (const p of popular) entries.push({ kind: "provider", provider: p });
  }

  if (configured.length > 0) {
    entries.push({ kind: "header", label: "Configured" });
    for (const p of configured) entries.push({ kind: "provider", provider: p });
  }

  if (q && other.length > 0) {
    entries.push({ kind: "header", label: "Other" });
    for (const p of other) entries.push({ kind: "provider", provider: p });
  } else if (!q && other.length > 0) {
    entries.push({ kind: "header", label: `${other.length} more — type to search` });
  }

  return entries;
}

export function ProviderPicker({
  listProviders,
  listModels,
  setProviderKey,
  removeProviderKey,
  setDefaultModel,
  onCancel,
  onDone,
}: Props) {
  const [view, setView] = useState<View>("providers");
  const [allProviders, setAllProviders] = useState<ProviderListItem[] | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelPickerProviderID, setModelPickerProviderID] = useState<string | undefined>();

  useEffect(() => {
    listProviders().then(setAllProviders).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [listProviders]);

  const refreshProviders = useCallback(() => {
    listProviders().then((p) => { setAllProviders(p); setError(null); }).catch(() => {});
  }, [listProviders]);

  const flatList = useMemo(
    () => (allProviders ? buildList(allProviders, searchFilter) : []),
    [allProviders, searchFilter],
  );

  const selectableIndices = useMemo(
    () => flatList.map((e, i) => (e.kind === "provider" ? i : -1)).filter((i) => i >= 0),
    [flatList],
  );

  const providerList = useScrollableList({ itemCount: selectableIndices.length, reservedRows: 8 });

  const activeFlatIdx = selectableIndices[providerList.selectedIndex] ?? -1;
  const selectedProvider =
    activeFlatIdx >= 0 && flatList[activeFlatIdx]?.kind === "provider"
      ? (flatList[activeFlatIdx] as { kind: "provider"; provider: ProviderListItem }).provider
      : null;

  // Provider list input
  usePickerInput({
    list: providerList,
    isActive: view === "providers",
    onEscape: () => {
      if (searchFilter) { setSearchFilter(""); providerList.setSelectedIndex(0); }
      else onCancel();
    },
    onEnter: () => {
      if (!selectedProvider) return;
      if (selectedProvider.hasKey) {
        setModelPickerProviderID(selectedProvider.id);
        setView("pick-model");
      } else {
        setView("enter-key");
        setKeyInput("");
        setError(null);
      }
    },
    onKey: (input, key) => {
      if (key.backspace || key.delete) {
        if (searchFilter) {
          setSearchFilter((prev) => prev.slice(0, -1));
          providerList.setSelectedIndex(0);
        } else if (key.delete && selectedProvider?.hasKey && selectedProvider.keySource === "stored") {
          removeProviderKey(selectedProvider.id)
            .then(() => refreshProviders())
            .catch((err) => { setError(err instanceof Error ? err.message : String(err)); });
        }
        return true;
      }
      if (isTextInput(input, key)) {
        setSearchFilter((prev) => prev + input);
        providerList.setSelectedIndex(0);
        return true;
      }
    },
  });

  // Enter-key view input
  useInput((input, key) => {
    if (view !== "enter-key") return;

    if (key.escape) { setView("providers"); setKeyInput(""); return; }
    if (key.return && keyInput.length > 0 && selectedProvider && !saving) {
      setSaving(true);
      const pid = selectedProvider.id;
      setProviderKey(pid, keyInput)
        .then(() => {
          setKeyInput("");
          setSaving(false);
          refreshProviders();
          setModelPickerProviderID(pid);
          setView("pick-model");
        })
        .catch((err) => { setError(err instanceof Error ? err.message : String(err)); setSaving(false); });
      return;
    }
    if (key.backspace || key.delete) { setKeyInput((prev) => prev.slice(0, -1)); return; }
    if (isTextInput(input, key)) { setKeyInput((prev) => prev + input); }
  });

  // ===================== RENDER =====================

  // --- Pick model view (delegates to ModelPicker) ---
  if (view === "pick-model") {
    return (
      <ModelPicker
        listModels={listModels}
        listProviders={listProviders}
        onSelect={(modelId) => {
          setDefaultModel(modelId)
            .then(() => { onDone(`Default model set to ${modelId}.`); })
            .catch((err) => { setError(err instanceof Error ? err.message : String(err)); setView("providers"); });
        }}
        onReset={() => { setView("providers"); }}
        onCancel={() => { setView("providers"); refreshProviders(); }}
        currentModel={null}
        initialProviderID={modelPickerProviderID}
      />
    );
  }

  // --- Provider list ---
  if (view === "providers") {
    if (allProviders === null) return <PickerLoading>Loading providers...</PickerLoading>;

    // Viewport over flat list centered on selected item
    const flatTotal = flatList.length;
    const vpSize = providerList.viewportSize;
    let flatStart: number;
    let flatEnd: number;
    if (flatTotal <= vpSize) {
      flatStart = 0;
      flatEnd = flatTotal;
    } else {
      const half = Math.floor(vpSize / 2);
      flatStart = activeFlatIdx - half;
      if (flatStart < 0) flatStart = 0;
      flatEnd = flatStart + vpSize;
      if (flatEnd > flatTotal) {
        flatEnd = flatTotal;
        flatStart = Math.max(0, flatEnd - vpSize);
      }
    }
    const visible = flatList.slice(flatStart, flatEnd);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="magenta">Providers</Text>
          <Text dimColor> (Enter: key/model, Del: remove key, Esc: back)</Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Search: </Text>
          <Text>{searchFilter}</Text>
          <Text color="cyan">█</Text>
        </Box>

        {error && <Box marginBottom={1}><Text color="red">Error: {error}</Text></Box>}

        {flatList.length === 0 && <Text dimColor>No providers match "{searchFilter}"</Text>}

        <ScrollHints hiddenAbove={flatStart} hiddenBelow={Math.max(0, flatTotal - flatEnd)}>
          <Box flexDirection="column" minHeight={providerList.viewportSize}>
            {visible.map((entry, vi) => {
              const realIdx = flatStart + vi;
              if (entry.kind === "header") {
                return (
                  <Box key={`h-${realIdx}`} marginTop={realIdx > 0 ? 1 : 0}>
                    <Text bold dimColor>  {entry.label}</Text>
                  </Box>
                );
              }
              const p = entry.provider;
              const selIdx = selectableIndices.indexOf(realIdx);
              const isSelected = selIdx === providerList.selectedIndex;
              const icon = p.hasKey ? (p.keySource === "env" ? "●" : "✓") : "✗";
              const color = p.hasKey ? (p.keySource === "env" ? "yellow" : "green") : "red";

              return (
                <Box key={p.id}>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>{isSelected ? "> " : "  "}</Text>
                  <Text color={color}>{icon} </Text>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>{p.name}</Text>
                  <Text dimColor> ({p.modelCount} models)</Text>
                  {p.hasKey && <Text dimColor> [{p.keySource}]</Text>}
                </Box>
              );
            })}
          </Box>
        </ScrollHints>
      </Box>
    );
  }

  // --- Enter key ---
  if (view === "enter-key") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="magenta">Enter API key for {selectedProvider?.name ?? "provider"}</Text>
        </Box>
        {error && <Box marginBottom={1}><Text color="red">Error: {error}</Text></Box>}
        <Box>
          <Text dimColor>Key: </Text>
          <Text>{"*".repeat(keyInput.length)}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{saving ? "Saving..." : "Enter to save, Escape to cancel"}</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
