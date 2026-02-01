import { useReducer, useRef, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────

export interface Cursor {
  row: number;
  col: number;
}

export interface TextBufferState {
  lines: string[];
  cursor: Cursor;
  /** Sticky column for vertical movement (null = use cursor.col) */
  desiredCol: number | null;
  /** First visible row when lines exceed maxVisibleLines */
  scrollOffset: number;
}

export const MAX_VISIBLE_LINES = 6;

// ── Helpers ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

/** Ensure scrollOffset keeps cursor visible. */
function adjustScroll(state: TextBufferState): TextBufferState {
  let { scrollOffset } = state;
  const { cursor, lines } = state;
  const maxVisible = Math.min(lines.length, MAX_VISIBLE_LINES);
  // cursor above viewport
  if (cursor.row < scrollOffset) {
    scrollOffset = cursor.row;
  }
  // cursor below viewport
  if (cursor.row >= scrollOffset + maxVisible) {
    scrollOffset = cursor.row - maxVisible + 1;
  }
  // clamp to valid range
  scrollOffset = clamp(scrollOffset, 0, Math.max(0, lines.length - maxVisible));
  if (scrollOffset === state.scrollOffset) return state;
  return { ...state, scrollOffset };
}

// ── Pure operations (reducer actions) ──────────────────────────────

export function insertChar(state: TextBufferState, ch: string): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  const newLine = line.slice(0, cursor.col) + ch + line.slice(cursor.col);
  const newLines = [...lines];
  newLines[cursor.row] = newLine;
  return adjustScroll({
    ...state,
    lines: newLines,
    cursor: { row: cursor.row, col: cursor.col + ch.length },
    desiredCol: null,
  });
}

export function insertText(state: TextBufferState, text: string): TextBufferState {
  // Handle pasted text that may contain newlines
  const parts = text.split("\n");
  let s = state;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) s = insertNewline(s);
    if (parts[i].length > 0) {
      // Insert the text chunk at current position
      const { lines, cursor } = s;
      const line = lines[cursor.row];
      const newLine = line.slice(0, cursor.col) + parts[i] + line.slice(cursor.col);
      const newLines = [...lines];
      newLines[cursor.row] = newLine;
      s = adjustScroll({
        ...s,
        lines: newLines,
        cursor: { row: cursor.row, col: cursor.col + parts[i].length },
        desiredCol: null,
      });
    }
  }
  return s;
}

export function insertNewline(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  const before = line.slice(0, cursor.col);
  const after = line.slice(cursor.col);
  const newLines = [
    ...lines.slice(0, cursor.row),
    before,
    after,
    ...lines.slice(cursor.row + 1),
  ];
  return adjustScroll({
    ...state,
    lines: newLines,
    cursor: { row: cursor.row + 1, col: 0 },
    desiredCol: null,
  });
}

export function deleteBackward(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  if (cursor.col > 0) {
    const line = lines[cursor.row];
    const newLine = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
    const newLines = [...lines];
    newLines[cursor.row] = newLine;
    return adjustScroll({
      ...state,
      lines: newLines,
      cursor: { row: cursor.row, col: cursor.col - 1 },
      desiredCol: null,
    });
  }
  if (cursor.row > 0) {
    // Merge with previous line
    const prevLine = lines[cursor.row - 1];
    const curLine = lines[cursor.row];
    const merged = prevLine + curLine;
    const newLines = [
      ...lines.slice(0, cursor.row - 1),
      merged,
      ...lines.slice(cursor.row + 1),
    ];
    return adjustScroll({
      ...state,
      lines: newLines,
      cursor: { row: cursor.row - 1, col: prevLine.length },
      desiredCol: null,
    });
  }
  return state;
}

export function deleteForward(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  if (cursor.col < line.length) {
    const newLine = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
    const newLines = [...lines];
    newLines[cursor.row] = newLine;
    return adjustScroll({
      ...state,
      lines: newLines,
      cursor: { ...cursor },
      desiredCol: null,
    });
  }
  if (cursor.row < lines.length - 1) {
    // Merge with next line
    const nextLine = lines[cursor.row + 1];
    const merged = line + nextLine;
    const newLines = [
      ...lines.slice(0, cursor.row),
      merged,
      ...lines.slice(cursor.row + 2),
    ];
    return adjustScroll({
      ...state,
      lines: newLines,
      cursor: { ...cursor },
      desiredCol: null,
    });
  }
  return state;
}

export function moveCursorLeft(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  if (cursor.col > 0) {
    return { ...state, cursor: { row: cursor.row, col: cursor.col - 1 }, desiredCol: null };
  }
  if (cursor.row > 0) {
    return {
      ...state,
      cursor: { row: cursor.row - 1, col: lines[cursor.row - 1].length },
      desiredCol: null,
    };
  }
  return state;
}

export function moveCursorRight(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  if (cursor.col < line.length) {
    return { ...state, cursor: { row: cursor.row, col: cursor.col + 1 }, desiredCol: null };
  }
  if (cursor.row < lines.length - 1) {
    return { ...state, cursor: { row: cursor.row + 1, col: 0 }, desiredCol: null };
  }
  return state;
}

export function moveCursorUp(state: TextBufferState): TextBufferState | "overflow" {
  const { lines, cursor, desiredCol } = state;
  if (cursor.row === 0) return "overflow";
  const targetCol = desiredCol ?? cursor.col;
  const newCol = Math.min(targetCol, lines[cursor.row - 1].length);
  return adjustScroll({
    ...state,
    cursor: { row: cursor.row - 1, col: newCol },
    desiredCol: targetCol,
  });
}

export function moveCursorDown(state: TextBufferState): TextBufferState | "overflow" {
  const { lines, cursor, desiredCol } = state;
  if (cursor.row === lines.length - 1) return "overflow";
  const targetCol = desiredCol ?? cursor.col;
  const newCol = Math.min(targetCol, lines[cursor.row + 1].length);
  return adjustScroll({
    ...state,
    cursor: { row: cursor.row + 1, col: newCol },
    desiredCol: targetCol,
  });
}

export function moveWordLeft(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  let { row, col } = cursor;
  // If at start of line, move to end of previous line
  if (col === 0 && row > 0) {
    row -= 1;
    col = lines[row].length;
  }
  const line = lines[row];
  // Skip non-word characters
  while (col > 0 && !isWordChar(line[col - 1])) col--;
  // Skip word characters
  while (col > 0 && isWordChar(line[col - 1])) col--;
  return adjustScroll({ ...state, cursor: { row, col }, desiredCol: null });
}

export function moveWordRight(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  let { row, col } = cursor;
  const line = lines[row];
  // If at end of line, move to start of next line
  if (col >= line.length && row < lines.length - 1) {
    row += 1;
    col = 0;
  }
  const targetLine = lines[row];
  // Skip word characters
  while (col < targetLine.length && isWordChar(targetLine[col])) col++;
  // Skip non-word characters
  while (col < targetLine.length && !isWordChar(targetLine[col])) col++;
  return adjustScroll({ ...state, cursor: { row, col }, desiredCol: null });
}

export function moveToLineStart(state: TextBufferState): TextBufferState {
  return { ...state, cursor: { row: state.cursor.row, col: 0 }, desiredCol: null };
}

export function moveToLineEnd(state: TextBufferState): TextBufferState {
  const line = state.lines[state.cursor.row];
  return { ...state, cursor: { row: state.cursor.row, col: line.length }, desiredCol: null };
}

export function deleteToLineEnd(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  if (cursor.col >= line.length && cursor.row < lines.length - 1) {
    // At end of line: join with next line
    const newLines = [
      ...lines.slice(0, cursor.row),
      line + lines[cursor.row + 1],
      ...lines.slice(cursor.row + 2),
    ];
    return adjustScroll({ ...state, lines: newLines, desiredCol: null });
  }
  const newLine = line.slice(0, cursor.col);
  const newLines = [...lines];
  newLines[cursor.row] = newLine;
  return adjustScroll({ ...state, lines: newLines, desiredCol: null });
}

export function deleteToLineStart(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  const line = lines[cursor.row];
  const newLine = line.slice(cursor.col);
  const newLines = [...lines];
  newLines[cursor.row] = newLine;
  return adjustScroll({
    ...state,
    lines: newLines,
    cursor: { row: cursor.row, col: 0 },
    desiredCol: null,
  });
}

export function deleteWordBackward(state: TextBufferState): TextBufferState {
  const { lines, cursor } = state;
  if (cursor.col === 0 && cursor.row === 0) return state;
  // Find where the word starts
  const target = moveWordLeft(state);
  const targetCursor = target.cursor;
  // If we moved to a different row, delete from target to current
  if (targetCursor.row < cursor.row) {
    // Delete from target position to current position (cross-line)
    const beforeLine = lines[targetCursor.row].slice(0, targetCursor.col);
    const afterLine = lines[cursor.row].slice(cursor.col);
    const newLines = [
      ...lines.slice(0, targetCursor.row),
      beforeLine + afterLine,
      ...lines.slice(cursor.row + 1),
    ];
    return adjustScroll({
      ...state,
      lines: newLines,
      cursor: targetCursor,
      desiredCol: null,
    });
  }
  // Same row
  const line = lines[cursor.row];
  const newLine = line.slice(0, targetCursor.col) + line.slice(cursor.col);
  const newLines = [...lines];
  newLines[cursor.row] = newLine;
  return adjustScroll({
    ...state,
    lines: newLines,
    cursor: targetCursor,
    desiredCol: null,
  });
}

export function setText(state: TextBufferState, text: string): TextBufferState {
  const lines = text.split("\n");
  if (lines.length === 0) lines.push("");
  const lastLine = lines[lines.length - 1];
  return adjustScroll({
    lines,
    cursor: { row: lines.length - 1, col: lastLine.length },
    desiredCol: null,
    scrollOffset: 0,
  });
}

export function getText(state: TextBufferState): string {
  return state.lines.join("\n");
}

// ── Initial state ──────────────────────────────────────────────────

export function createInitialState(text: string = ""): TextBufferState {
  const lines = text.split("\n");
  if (lines.length === 0) lines.push("");
  const lastLine = lines[lines.length - 1];
  return adjustScroll({
    lines,
    cursor: { row: lines.length - 1, col: lastLine.length },
    desiredCol: null,
    scrollOffset: 0,
  });
}

// ── Reducer ────────────────────────────────────────────────────────

export type TextBufferAction =
  | { type: "insert_char"; char: string }
  | { type: "insert_text"; text: string }
  | { type: "insert_newline" }
  | { type: "delete_backward" }
  | { type: "delete_forward" }
  | { type: "move_left" }
  | { type: "move_right" }
  | { type: "move_up" }
  | { type: "move_down" }
  | { type: "move_word_left" }
  | { type: "move_word_right" }
  | { type: "move_to_line_start" }
  | { type: "move_to_line_end" }
  | { type: "delete_to_line_end" }
  | { type: "delete_to_line_start" }
  | { type: "delete_word_backward" }
  | { type: "set_text"; text: string };

export interface TextBufferReducerResult {
  state: TextBufferState;
  overflow?: "up" | "down";
}

export function textBufferReducer(
  prev: TextBufferReducerResult,
  action: TextBufferAction,
): TextBufferReducerResult {
  const state = prev.state;
  switch (action.type) {
    case "insert_char":
      return { state: insertChar(state, action.char) };
    case "insert_text":
      return { state: insertText(state, action.text) };
    case "insert_newline":
      return { state: insertNewline(state) };
    case "delete_backward":
      return { state: deleteBackward(state) };
    case "delete_forward":
      return { state: deleteForward(state) };
    case "move_left":
      return { state: moveCursorLeft(state) };
    case "move_right":
      return { state: moveCursorRight(state) };
    case "move_up": {
      const result = moveCursorUp(state);
      if (result === "overflow") return { state, overflow: "up" };
      return { state: result };
    }
    case "move_down": {
      const result = moveCursorDown(state);
      if (result === "overflow") return { state, overflow: "down" };
      return { state: result };
    }
    case "move_word_left":
      return { state: moveWordLeft(state) };
    case "move_word_right":
      return { state: moveWordRight(state) };
    case "move_to_line_start":
      return { state: moveToLineStart(state) };
    case "move_to_line_end":
      return { state: moveToLineEnd(state) };
    case "delete_to_line_end":
      return { state: deleteToLineEnd(state) };
    case "delete_to_line_start":
      return { state: deleteToLineStart(state) };
    case "delete_word_backward":
      return { state: deleteWordBackward(state) };
    case "set_text":
      return { state: setText(state, action.text) };
    default:
      return prev;
  }
}

// ── Hook ───────────────────────────────────────────────────────────

export interface UseTextBufferOptions {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onOverflowUp?: () => void;
  onOverflowDown?: () => void;
}

export interface UseTextBufferReturn {
  state: TextBufferState;
  dispatch: (action: TextBufferAction) => void;
  /** Get the full text value */
  text: string;
  /** Number of visible lines (capped at MAX_VISIBLE_LINES) */
  visibleLineCount: number;
}

export function useTextBuffer({
  value,
  onChange,
  onOverflowUp,
  onOverflowDown,
}: UseTextBufferOptions): UseTextBufferReturn {
  const [result, rawDispatch] = useReducer(textBufferReducer, {
    state: createInitialState(value),
  });

  // Track external value prop to detect outside changes
  const lastInternalText = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onOverflowUpRef = useRef(onOverflowUp);
  onOverflowUpRef.current = onOverflowUp;
  const onOverflowDownRef = useRef(onOverflowDown);
  onOverflowDownRef.current = onOverflowDown;

  // Sync external value changes into buffer state
  useEffect(() => {
    const currentText = getText(result.state);
    if (value !== lastInternalText.current && value !== currentText) {
      rawDispatch({ type: "set_text", text: value });
      lastInternalText.current = value;
    }
  }, [value, result.state]);

  // Handle overflow notifications by tracking result reference changes
  const prevResultRef = useRef(result);
  useEffect(() => {
    if (result !== prevResultRef.current && result.overflow) {
      if (result.overflow === "up") {
        onOverflowUpRef.current?.();
      } else if (result.overflow === "down") {
        onOverflowDownRef.current?.();
      }
    }
    prevResultRef.current = result;
  });

  const dispatch = useCallback((action: TextBufferAction) => {
    rawDispatch(action);
  }, []);

  // Notify parent of text changes after each dispatch
  const prevText = useRef(getText(result.state));
  useEffect(() => {
    const currentText = getText(result.state);
    if (currentText !== prevText.current) {
      prevText.current = currentText;
      lastInternalText.current = currentText;
      onChangeRef.current?.(currentText);
    }
  }, [result.state]);

  const visibleLineCount = Math.min(result.state.lines.length, MAX_VISIBLE_LINES);

  return {
    state: result.state,
    dispatch,
    text: getText(result.state),
    visibleLineCount,
  };
}
