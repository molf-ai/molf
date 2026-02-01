import React, { useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import {
  useTextBuffer,
  getText,
  MAX_VISIBLE_LINES,
  type TextBufferAction,
} from "../hooks/use-text-buffer.js";

export interface TextAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onOverflowUp?: () => void;
  onOverflowDown?: () => void;
  isActive?: boolean;
  /** When true, up/down arrows are ignored (e.g. for autocomplete navigation) */
  suppressUpDown?: boolean;
  placeholder?: string;
}

export function TextArea({
  value,
  onChange,
  onSubmit,
  onOverflowUp,
  onOverflowDown,
  isActive = true,
  suppressUpDown = false,
  placeholder = "",
}: TextAreaProps) {
  const { state, dispatch, text, visibleLineCount } = useTextBuffer({
    value,
    onChange,
    onOverflowUp,
    onOverflowDown,
  });

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useInput(
    (input, key) => {
      // Ignore arrow keys, tab, Ctrl+C, Escape — let parent handle these
      if (key.ctrl && input === "c") return;
      if (key.escape) return;
      if (key.tab) return;

      // Arrow keys with meta (Alt) → word movement
      if (key.leftArrow && key.meta) {
        dispatch({ type: "move_word_left" });
        return;
      }
      if (key.rightArrow && key.meta) {
        dispatch({ type: "move_word_right" });
        return;
      }

      // Up/Down arrow: delegate to buffer (handles overflow internally via reducer)
      // Suppressed when parent handles up/down (e.g. autocomplete navigation)
      if (key.upArrow && !suppressUpDown) {
        dispatch({ type: "move_up" });
        return;
      }
      if (key.downArrow && !suppressUpDown) {
        dispatch({ type: "move_down" });
        return;
      }

      // Left/Right arrow: basic cursor movement
      if (key.leftArrow) {
        dispatch({ type: "move_left" });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: "move_right" });
        return;
      }

      // Ctrl shortcuts
      if (key.ctrl) {
        switch (input) {
          case "a":
            dispatch({ type: "move_to_line_start" });
            return;
          case "e":
            dispatch({ type: "move_to_line_end" });
            return;
          case "k":
            dispatch({ type: "delete_to_line_end" });
            return;
          case "u":
            dispatch({ type: "delete_to_line_start" });
            return;
          case "w":
            dispatch({ type: "delete_word_backward" });
            return;
          case "d":
            dispatch({ type: "delete_forward" });
            return;
          default:
            return;
        }
      }

      // Alt+Enter → insert newline
      if (key.return && key.meta) {
        dispatch({ type: "insert_newline" });
        return;
      }

      // Enter → submit
      if (key.return) {
        onSubmitRef.current(getText(state));
        return;
      }

      // Backspace / Delete key
      // Ink maps \x7f (what terminals send for backspace) to key.delete,
      // and \b (Ctrl+H) to key.backspace. Both should do backward delete.
      if (key.backspace || key.delete) {
        dispatch({ type: "delete_backward" });
        return;
      }

      // Regular text input (including paste)
      if (input.length > 0) {
        // Check for embedded newlines (paste)
        if (input.includes("\n") || input.includes("\r")) {
          const normalized = input.replace(/\r\n?/g, "\n");
          dispatch({ type: "insert_text", text: normalized });
        } else {
          dispatch({ type: "insert_text", text: input });
        }
      }
    },
    { isActive },
  );

  const { lines, cursor, scrollOffset } = state;
  const visibleEnd = scrollOffset + visibleLineCount;
  const visibleLines = lines.slice(scrollOffset, visibleEnd);

  const showScrollUp = scrollOffset > 0;
  const showScrollDown = visibleEnd < lines.length;

  // Render with placeholder
  if (lines.length === 1 && lines[0] === "" && isActive) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text inverse>{placeholder.length > 0 ? placeholder[0] : " "}</Text>
          {placeholder.length > 1 && <Text dimColor>{placeholder.slice(1)}</Text>}
        </Box>
      </Box>
    );
  }

  if (lines.length === 1 && lines[0] === "" && !isActive) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{placeholder || " "}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showScrollUp && <Text dimColor>{"..."}</Text>}
      {visibleLines.map((line, i) => {
        const actualRow = scrollOffset + i;
        const isCursorRow = actualRow === cursor.row;

        if (!isCursorRow || !isActive) {
          return (
            <Text key={actualRow}>
              {line || " "}
            </Text>
          );
        }

        // Render line with cursor
        const before = line.slice(0, cursor.col);
        const cursorChar = cursor.col < line.length ? line[cursor.col] : " ";
        const after = cursor.col < line.length ? line.slice(cursor.col + 1) : "";

        return (
          <Text key={actualRow}>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
          </Text>
        );
      })}
      {showScrollDown && <Text dimColor>{"..."}</Text>}
    </Box>
  );
}
