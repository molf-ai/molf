import { describe, test, expect } from "vitest";
import {
  createInitialState,
  insertChar,
  insertText,
  insertNewline,
  deleteBackward,
  deleteForward,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUp,
  moveCursorDown,
  moveWordLeft,
  moveWordRight,
  moveToLineStart,
  moveToLineEnd,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  setText,
  getText,
  MAX_VISIBLE_LINES,
  type TextBufferState,
} from "../src/hooks/use-text-buffer.js";

// Helper to build a state at a specific cursor position
function stateAt(text: string, row: number, col: number): TextBufferState {
  const lines = text.split("\n");
  return { lines, cursor: { row, col }, desiredCol: null, scrollOffset: 0 };
}

describe("createInitialState", () => {
  test("empty string creates single empty line", () => {
    const s = createInitialState("");
    expect(s.lines).toEqual([""]);
    expect(s.cursor).toEqual({ row: 0, col: 0 });
  });

  test("simple text — cursor at end", () => {
    const s = createInitialState("hello");
    expect(s.lines).toEqual(["hello"]);
    expect(s.cursor).toEqual({ row: 0, col: 5 });
  });

  test("multiline text — cursor at end", () => {
    const s = createInitialState("hello\nworld");
    expect(s.lines).toEqual(["hello", "world"]);
    expect(s.cursor).toEqual({ row: 1, col: 5 });
  });
});

describe("insertChar", () => {
  test("insert at start of empty line", () => {
    const s = createInitialState("");
    const r = insertChar(s, "a");
    expect(r.lines).toEqual(["a"]);
    expect(r.cursor).toEqual({ row: 0, col: 1 });
  });

  test("insert in middle of text", () => {
    const s = stateAt("hllo", 0, 1);
    const r = insertChar(s, "e");
    expect(r.lines).toEqual(["hello"]);
    expect(r.cursor).toEqual({ row: 0, col: 2 });
  });

  test("insert at end of text", () => {
    const s = stateAt("abc", 0, 3);
    const r = insertChar(s, "d");
    expect(r.lines).toEqual(["abcd"]);
    expect(r.cursor).toEqual({ row: 0, col: 4 });
  });

  test("insert on second line", () => {
    const s = stateAt("hello\nwrld", 1, 1);
    const r = insertChar(s, "o");
    expect(r.lines).toEqual(["hello", "world"]);
    expect(r.cursor).toEqual({ row: 1, col: 2 });
  });

  test("clears desiredCol", () => {
    const s = { ...stateAt("hello", 0, 3), desiredCol: 10 };
    const r = insertChar(s, "x");
    expect(r.desiredCol).toBeNull();
  });
});

describe("insertText", () => {
  test("insert single-line text", () => {
    const s = createInitialState("");
    const r = insertText(s, "hello");
    expect(getText(r)).toBe("hello");
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("insert multiline text (paste)", () => {
    const s = createInitialState("");
    const r = insertText(s, "line1\nline2\nline3");
    expect(r.lines).toEqual(["line1", "line2", "line3"]);
    expect(r.cursor).toEqual({ row: 2, col: 5 });
  });

  test("insert multiline in the middle of existing text", () => {
    const s = stateAt("helloworld", 0, 5);
    const r = insertText(s, "\n");
    expect(r.lines).toEqual(["hello", "world"]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("insertNewline", () => {
  test("split line at cursor", () => {
    const s = stateAt("helloworld", 0, 5);
    const r = insertNewline(s);
    expect(r.lines).toEqual(["hello", "world"]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });

  test("newline at start of line", () => {
    const s = stateAt("hello", 0, 0);
    const r = insertNewline(s);
    expect(r.lines).toEqual(["", "hello"]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });

  test("newline at end of line", () => {
    const s = stateAt("hello", 0, 5);
    const r = insertNewline(s);
    expect(r.lines).toEqual(["hello", ""]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });

  test("newline in middle of multiline", () => {
    const s = stateAt("abc\ndef", 0, 2);
    const r = insertNewline(s);
    expect(r.lines).toEqual(["ab", "c", "def"]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("deleteBackward", () => {
  test("delete char in middle of line", () => {
    const s = stateAt("hello", 0, 3);
    const r = deleteBackward(s);
    expect(r.lines).toEqual(["helo"]);
    expect(r.cursor).toEqual({ row: 0, col: 2 });
  });

  test("delete at start of line merges with previous", () => {
    const s = stateAt("hello\nworld", 1, 0);
    const r = deleteBackward(s);
    expect(r.lines).toEqual(["helloworld"]);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("noop at start of buffer", () => {
    const s = stateAt("hello", 0, 0);
    const r = deleteBackward(s);
    expect(r).toBe(s);
  });

  test("delete last char", () => {
    const s = stateAt("a", 0, 1);
    const r = deleteBackward(s);
    expect(r.lines).toEqual([""]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });
});

describe("deleteForward", () => {
  test("delete char in middle of line", () => {
    const s = stateAt("hello", 0, 2);
    const r = deleteForward(s);
    expect(r.lines).toEqual(["helo"]);
    expect(r.cursor).toEqual({ row: 0, col: 2 });
  });

  test("delete at end of line merges with next", () => {
    const s = stateAt("hello\nworld", 0, 5);
    const r = deleteForward(s);
    expect(r.lines).toEqual(["helloworld"]);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("noop at end of buffer", () => {
    const s = stateAt("hello", 0, 5);
    const r = deleteForward(s);
    expect(r).toBe(s);
  });
});

describe("moveCursorLeft", () => {
  test("move left within line", () => {
    const s = stateAt("hello", 0, 3);
    const r = moveCursorLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 2 });
  });

  test("move left at start of line wraps to previous", () => {
    const s = stateAt("hello\nworld", 1, 0);
    const r = moveCursorLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("noop at start of buffer", () => {
    const s = stateAt("hello", 0, 0);
    const r = moveCursorLeft(s);
    expect(r).toBe(s);
  });
});

describe("moveCursorRight", () => {
  test("move right within line", () => {
    const s = stateAt("hello", 0, 2);
    const r = moveCursorRight(s);
    expect(r.cursor).toEqual({ row: 0, col: 3 });
  });

  test("move right at end of line wraps to next", () => {
    const s = stateAt("hello\nworld", 0, 5);
    const r = moveCursorRight(s);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });

  test("noop at end of buffer", () => {
    const s = stateAt("hello", 0, 5);
    const r = moveCursorRight(s);
    expect(r).toBe(s);
  });
});

describe("moveCursorUp", () => {
  test("move up between lines", () => {
    const s = stateAt("hello\nworld", 1, 3);
    const r = moveCursorUp(s);
    expect(r).not.toBe("overflow");
    if (r !== "overflow") {
      expect(r.cursor).toEqual({ row: 0, col: 3 });
    }
  });

  test("overflow at first line", () => {
    const s = stateAt("hello", 0, 2);
    const r = moveCursorUp(s);
    expect(r).toBe("overflow");
  });

  test("clamps col to shorter line", () => {
    const s = stateAt("hi\nhello", 1, 4);
    const r = moveCursorUp(s);
    expect(r).not.toBe("overflow");
    if (r !== "overflow") {
      expect(r.cursor).toEqual({ row: 0, col: 2 });
      expect(r.desiredCol).toBe(4);
    }
  });

  test("uses desiredCol to restore position", () => {
    const s = { ...stateAt("hello\nhi\nworld", 1, 2), desiredCol: 4 };
    // Move down from line 1 (col clamped to 2) with desired 4
    const r = moveCursorDown(s);
    expect(r).not.toBe("overflow");
    if (r !== "overflow") {
      expect(r.cursor).toEqual({ row: 2, col: 4 });
      expect(r.desiredCol).toBe(4);
    }
  });
});

describe("moveCursorDown", () => {
  test("move down between lines", () => {
    const s = stateAt("hello\nworld", 0, 3);
    const r = moveCursorDown(s);
    expect(r).not.toBe("overflow");
    if (r !== "overflow") {
      expect(r.cursor).toEqual({ row: 1, col: 3 });
    }
  });

  test("overflow at last line", () => {
    const s = stateAt("hello", 0, 2);
    const r = moveCursorDown(s);
    expect(r).toBe("overflow");
  });

  test("clamps col to shorter line", () => {
    const s = stateAt("hello\nhi", 0, 4);
    const r = moveCursorDown(s);
    expect(r).not.toBe("overflow");
    if (r !== "overflow") {
      expect(r.cursor).toEqual({ row: 1, col: 2 });
      expect(r.desiredCol).toBe(4);
    }
  });
});

describe("moveWordLeft", () => {
  test("jump over word", () => {
    const s = stateAt("hello world", 0, 11);
    const r = moveWordLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 6 });
  });

  test("jump over spaces then word", () => {
    const s = stateAt("hello world", 0, 6);
    const r = moveWordLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("at start of line, jump to end of previous", () => {
    const s = stateAt("hello\nworld", 1, 0);
    const r = moveWordLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("noop at start of buffer", () => {
    const s = stateAt("hello", 0, 0);
    const r = moveWordLeft(s);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });
});

describe("moveWordRight", () => {
  test("jump over word", () => {
    const s = stateAt("hello world", 0, 0);
    const r = moveWordRight(s);
    expect(r.cursor).toEqual({ row: 0, col: 6 });
  });

  test("jump from middle of word to next word", () => {
    const s = stateAt("hello world", 0, 2);
    const r = moveWordRight(s);
    expect(r.cursor).toEqual({ row: 0, col: 6 });
  });

  test("at end of line, jump to start of next", () => {
    const s = stateAt("hello\nworld", 0, 5);
    const r = moveWordRight(s);
    expect(r.cursor).toEqual({ row: 1, col: 5 });
  });

  test("noop at end of buffer", () => {
    const s = stateAt("hello", 0, 5);
    const r = moveWordRight(s);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });
});

describe("moveToLineStart", () => {
  test("moves to column 0", () => {
    const s = stateAt("hello", 0, 3);
    const r = moveToLineStart(s);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("stays on same row", () => {
    const s = stateAt("hello\nworld", 1, 3);
    const r = moveToLineStart(s);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("moveToLineEnd", () => {
  test("moves to end of line", () => {
    const s = stateAt("hello", 0, 0);
    const r = moveToLineEnd(s);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("stays on same row", () => {
    const s = stateAt("hello\nworld", 1, 0);
    const r = moveToLineEnd(s);
    expect(r.cursor).toEqual({ row: 1, col: 5 });
  });
});

describe("deleteToLineEnd (Ctrl+K)", () => {
  test("delete from middle to end of line", () => {
    const s = stateAt("hello world", 0, 5);
    const r = deleteToLineEnd(s);
    expect(r.lines).toEqual(["hello"]);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("at end of line, joins with next line", () => {
    const s = stateAt("hello\nworld", 0, 5);
    const r = deleteToLineEnd(s);
    expect(r.lines).toEqual(["helloworld"]);
    expect(r.cursor).toEqual({ row: 0, col: 5 });
  });

  test("noop at end of last line", () => {
    const s = stateAt("hello", 0, 5);
    const r = deleteToLineEnd(s);
    expect(r.lines).toEqual(["hello"]);
  });
});

describe("deleteToLineStart (Ctrl+U)", () => {
  test("delete from middle to start of line", () => {
    const s = stateAt("hello world", 0, 5);
    const r = deleteToLineStart(s);
    expect(r.lines).toEqual([" world"]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("noop at start of line", () => {
    const s = stateAt("hello", 0, 0);
    const r = deleteToLineStart(s);
    expect(r.lines).toEqual(["hello"]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("on second line", () => {
    const s = stateAt("hello\nworld", 1, 3);
    const r = deleteToLineStart(s);
    expect(r.lines).toEqual(["hello", "ld"]);
    expect(r.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("deleteWordBackward (Ctrl+W)", () => {
  test("delete word", () => {
    const s = stateAt("hello world", 0, 11);
    const r = deleteWordBackward(s);
    expect(r.lines).toEqual(["hello "]);
    expect(r.cursor).toEqual({ row: 0, col: 6 });
  });

  test("delete word and trailing spaces", () => {
    const s = stateAt("hello world", 0, 6);
    const r = deleteWordBackward(s);
    expect(r.lines).toEqual(["world"]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("at start of line, joins with previous", () => {
    const s = stateAt("hello\nworld", 1, 0);
    const r = deleteWordBackward(s);
    expect(r.lines).toEqual(["world"]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });

  test("noop at start of buffer", () => {
    const s = stateAt("hello", 0, 0);
    const r = deleteWordBackward(s);
    expect(r).toBe(s);
  });
});

describe("setText", () => {
  test("replaces entire content", () => {
    const s = stateAt("hello\nworld", 0, 3);
    const r = setText(s, "new text");
    expect(r.lines).toEqual(["new text"]);
    expect(r.cursor).toEqual({ row: 0, col: 8 });
  });

  test("multiline replacement", () => {
    const s = createInitialState("");
    const r = setText(s, "line1\nline2");
    expect(r.lines).toEqual(["line1", "line2"]);
    expect(r.cursor).toEqual({ row: 1, col: 5 });
  });

  test("empty text gives single empty line", () => {
    const s = stateAt("hello", 0, 3);
    const r = setText(s, "");
    expect(r.lines).toEqual([""]);
    expect(r.cursor).toEqual({ row: 0, col: 0 });
  });
});

describe("getText", () => {
  test("single line", () => {
    const s = stateAt("hello", 0, 0);
    expect(getText(s)).toBe("hello");
  });

  test("multiline", () => {
    const s = stateAt("hello\nworld", 0, 0);
    expect(getText(s)).toBe("hello\nworld");
  });

  test("empty", () => {
    const s = createInitialState("");
    expect(getText(s)).toBe("");
  });
});

describe("scroll management", () => {
  test("scrollOffset adjusts when cursor goes below viewport", () => {
    // Build a state with 8 lines, cursor on line 0
    let s = createInitialState("");
    for (let i = 0; i < 7; i++) {
      s = insertNewline(s);
      s = insertText(s, `line ${i + 1}`);
    }
    // cursor should be on line 7
    expect(s.cursor.row).toBe(7);
    // scrollOffset should keep cursor visible
    expect(s.scrollOffset).toBe(7 - MAX_VISIBLE_LINES + 1);
  });

  test("scrollOffset adjusts when cursor goes above viewport", () => {
    // Create 8 lines, cursor at bottom
    let s = createInitialState("0\n1\n2\n3\n4\n5\n6\n7");
    s = setText(s, "0\n1\n2\n3\n4\n5\n6\n7");
    // cursor at end (row 7)
    expect(s.cursor.row).toBe(7);
    // Move cursor to top
    for (let i = 0; i < 7; i++) {
      const r = moveCursorUp(s);
      if (r !== "overflow") s = r;
    }
    expect(s.cursor.row).toBe(0);
    expect(s.scrollOffset).toBe(0);
  });
});

describe("desiredCol (sticky column)", () => {
  test("preserved across vertical movement through short line", () => {
    // Line 0: "hello" (5 chars)
    // Line 1: "hi" (2 chars)
    // Line 2: "world" (5 chars)
    const s = stateAt("hello\nhi\nworld", 0, 4);

    const r1 = moveCursorDown(s);
    expect(r1).not.toBe("overflow");
    if (r1 === "overflow") return;
    // col clamped to 2, desiredCol = 4
    expect(r1.cursor).toEqual({ row: 1, col: 2 });
    expect(r1.desiredCol).toBe(4);

    const r2 = moveCursorDown(r1);
    expect(r2).not.toBe("overflow");
    if (r2 === "overflow") return;
    // desiredCol 4 restored
    expect(r2.cursor).toEqual({ row: 2, col: 4 });
    expect(r2.desiredCol).toBe(4);
  });

  test("cleared on horizontal movement", () => {
    const s = { ...stateAt("hello\nhi", 0, 4), desiredCol: 4 };
    const r = moveCursorLeft(s);
    expect(r.desiredCol).toBeNull();
  });

  test("cleared on character insertion", () => {
    const s = { ...stateAt("hello", 0, 3), desiredCol: 5 };
    const r = insertChar(s, "x");
    expect(r.desiredCol).toBeNull();
  });
});

describe("complex editing sequences", () => {
  test("type, newline, type, submit gives multiline text", () => {
    let s = createInitialState("");
    s = insertText(s, "hello");
    s = insertNewline(s);
    s = insertText(s, "world");
    expect(getText(s)).toBe("hello\nworld");
    expect(s.cursor).toEqual({ row: 1, col: 5 });
  });

  test("backspace across newline", () => {
    let s = createInitialState("");
    s = insertText(s, "hello");
    s = insertNewline(s);
    s = deleteBackward(s);
    expect(getText(s)).toBe("hello");
    expect(s.cursor).toEqual({ row: 0, col: 5 });
  });

  test("Ctrl+K then type replaces to end of line", () => {
    let s = stateAt("hello world", 0, 5);
    s = deleteToLineEnd(s);
    s = insertText(s, " there");
    expect(getText(s)).toBe("hello there");
  });

  test("Ctrl+U then type replaces from start of line", () => {
    let s = stateAt("hello world", 0, 6);
    s = deleteToLineStart(s);
    s = insertText(s, "new ");
    expect(getText(s)).toBe("new world");
  });
});
