import { useInput } from "ink";
import type { Key } from "ink";
import type { ScrollableListReturn } from "./use-scrollable-list.js";

export interface UsePickerInputOptions {
  list: Pick<ScrollableListReturn, "moveUp" | "moveDown">;
  onEscape: () => void;
  onEnter?: () => void;
  /** Handle picker-specific keys. Return true to indicate the key was handled. */
  onKey?: (input: string, key: Key) => boolean | void;
  /** When false, input is ignored. Useful for multi-level pickers. Default true. */
  isActive?: boolean;
}

/**
 * Shared input handler for picker components.
 * Handles Escape (cancel), Up/Down (navigate), Enter (select).
 * Picker-specific keys go in the `onKey` callback.
 */
export function usePickerInput(opts: UsePickerInputOptions): void {
  const { list, onEscape, onEnter, onKey, isActive = true } = opts;

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      onEscape();
      return;
    }

    // Let picker-specific keys take priority before navigation
    if (onKey?.(input, key)) return;

    if (key.upArrow) {
      list.moveUp();
      return;
    }
    if (key.downArrow) {
      list.moveDown();
      return;
    }
    if (key.return && onEnter) {
      onEnter();
      return;
    }
  });
}
