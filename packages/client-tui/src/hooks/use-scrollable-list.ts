import { useState, useMemo, useCallback } from "react";
import { useStdout } from "ink";

export interface ScrollableListOptions {
  /** Total item count. */
  itemCount: number;
  /** Rows reserved for chrome outside the list (header, search bar, footer). Default 6. */
  reservedRows?: number;
}

export interface ScrollableListReturn {
  /** Currently selected index (clamped to valid range). */
  selectedIndex: number;
  /** Move selection up. Wraps around. */
  moveUp: () => void;
  /** Move selection down. Wraps around. */
  moveDown: () => void;
  /** Set selection to specific index. */
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  /** First visible index (inclusive). */
  visibleStart: number;
  /** Last visible index (exclusive). */
  visibleEnd: number;
  /** Number of items hidden above the viewport. */
  hiddenAbove: number;
  /** Number of items hidden below the viewport. */
  hiddenBelow: number;
  /** Max items that fit in the viewport. */
  viewportSize: number;
}

/**
 * Shared hook for scrollable list navigation in TUI pickers.
 *
 * Handles:
 * - selectedIndex with wrap-around
 * - Viewport window that follows the selection (auto-scroll)
 * - Terminal height detection via `useStdout`
 *
 * Does NOT handle:
 * - Key input (caller uses `useInput` and calls moveUp/moveDown)
 * - Rendering (caller renders only items[visibleStart..visibleEnd])
 * - Filtering (caller filters items before passing itemCount)
 */
export function useScrollableList(opts: ScrollableListOptions): ScrollableListReturn {
  const { itemCount, reservedRows = 6 } = opts;
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const viewportSize = Math.max(3, termRows - reservedRows);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp to valid range
  const clamped = itemCount > 0 ? Math.min(Math.max(selectedIndex, 0), itemCount - 1) : 0;

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      if (itemCount === 0) return 0;
      return prev <= 0 ? itemCount - 1 : prev - 1;
    });
  }, [itemCount]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      if (itemCount === 0) return 0;
      return prev >= itemCount - 1 ? 0 : prev + 1;
    });
  }, [itemCount]);

  // Compute scroll window around selection
  const { visibleStart, visibleEnd } = useMemo(() => {
    if (itemCount <= viewportSize) return { visibleStart: 0, visibleEnd: itemCount };
    const half = Math.floor(viewportSize / 2);
    let start = clamped - half;
    if (start < 0) start = 0;
    let end = start + viewportSize;
    if (end > itemCount) {
      end = itemCount;
      start = Math.max(0, end - viewportSize);
    }
    return { visibleStart: start, visibleEnd: end };
  }, [itemCount, viewportSize, clamped]);

  return {
    selectedIndex: clamped,
    moveUp,
    moveDown,
    setSelectedIndex,
    visibleStart,
    visibleEnd,
    hiddenAbove: visibleStart,
    hiddenBelow: Math.max(0, itemCount - visibleEnd),
    viewportSize,
  };
}
