import { useState, useEffect, useCallback } from "react";
import type { DisplayMessage } from "../types.js";

/** Extract user message contents from display messages. */
export function extractUserEntries(messages: DisplayMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);
}

/**
 * Navigate: returns new index given direction, or undefined if at boundary.
 * `entriesLength` is the number of history entries; index === entriesLength means "present".
 */
export function navigateIndex(
  entriesLength: number,
  currentIndex: number,
  direction: "up" | "down",
): number | undefined {
  if (direction === "up") {
    if (entriesLength === 0) return undefined;
    if (currentIndex === entriesLength) return entriesLength - 1;
    if (currentIndex > 0) return currentIndex - 1;
    return undefined;
  }
  // direction === "down"
  if (currentIndex >= entriesLength) return undefined;
  return currentIndex + 1;
}

/**
 * Get display value for a given navigation index.
 * When index === entries.length, returns the draft (user's in-progress text).
 */
export function getValueAtIndex(
  entries: string[],
  index: number,
  draft: string,
): string {
  if (index >= entries.length) return draft;
  return entries[index];
}

/**
 * Merge new entries from messages into existing accumulated history.
 * Only appends entries that aren't already present, preserving cross-session history.
 */
export function mergeNewEntries(
  existing: string[],
  fromMessages: string[],
): string[] {
  const existingSet = new Set(existing);
  const newOnes = fromMessages.filter((e) => !existingSet.has(e));
  if (newOnes.length === 0) return existing;
  return [...existing, ...newOnes];
}

export interface UseInputHistoryReturn {
  navigateUp: (currentInput: string) => string | undefined;
  navigateDown: (currentInput: string) => string | undefined;
  addEntry: (value: string) => void;
  isNavigating: boolean;
}

export function useInputHistory(messages: DisplayMessage[]): UseInputHistoryReturn {
  const [entries, setEntries] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("");

  // Append new user messages into accumulated history (survives /clear and session switches)
  useEffect(() => {
    const fromMessages = extractUserEntries(messages);
    setEntries((prev) => {
      const merged = mergeNewEntries(prev, fromMessages);
      if (merged !== prev) {
        setIndex(merged.length);
        setDraft("");
      }
      return merged;
    });
  }, [messages]);

  const navigateUp = useCallback(
    (currentInput: string): string | undefined => {
      const newIndex = navigateIndex(entries.length, index, "up");
      if (newIndex === undefined) return undefined;

      if (index === entries.length) {
        setDraft(currentInput);
      }
      setIndex(newIndex);
      return getValueAtIndex(entries, newIndex, draft);
    },
    [entries, index, draft],
  );

  const navigateDown = useCallback(
    (currentInput: string): string | undefined => {
      const newIndex = navigateIndex(entries.length, index, "down");
      if (newIndex === undefined) return undefined;

      setIndex(newIndex);
      return getValueAtIndex(entries, newIndex, draft);
    },
    [entries, index, draft],
  );

  const addEntry = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") return;

      // Consecutive dedup
      if (entries.length > 0 && entries[entries.length - 1] === trimmed) {
        setIndex(entries.length);
        setDraft("");
        return;
      }

      setEntries((prev) => {
        const next = [...prev, trimmed];
        setIndex(next.length);
        return next;
      });
      setDraft("");
    },
    [entries],
  );

  const isNavigating = index < entries.length;

  return { navigateUp, navigateDown, addEntry, isNavigating };
}
