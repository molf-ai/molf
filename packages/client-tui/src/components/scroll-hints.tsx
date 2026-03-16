import React from "react";
import type { ReactNode } from "react";
import { Text } from "ink";

interface Props {
  hiddenAbove: number;
  hiddenBelow: number;
  children: ReactNode;
}

/**
 * Wraps list content with "↑ N more" / "↓ N more" scroll indicators.
 */
export function ScrollHints({ hiddenAbove, hiddenBelow, children }: Props) {
  return (
    <>
      {hiddenAbove > 0 && <Text dimColor>  ↑ {hiddenAbove} more</Text>}
      {children}
      {hiddenBelow > 0 && <Text dimColor>  ↓ {hiddenBelow} more</Text>}
    </>
  );
}
