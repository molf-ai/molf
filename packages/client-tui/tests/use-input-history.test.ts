import { describe, test, expect } from "vitest";
import {
  extractUserEntries,
  navigateIndex,
  getValueAtIndex,
  mergeNewEntries,
} from "../src/hooks/use-input-history.js";
import type { DisplayMessage } from "../src/types.js";

function makeMessage(
  role: DisplayMessage["role"],
  content: string,
  id?: string,
): DisplayMessage {
  return {
    id: id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe("extractUserEntries", () => {
  test("returns empty array for no messages", () => {
    expect(extractUserEntries([])).toEqual([]);
  });

  test("filters only user-role messages", () => {
    const messages: DisplayMessage[] = [
      makeMessage("user", "hello"),
      makeMessage("assistant", "hi there"),
      makeMessage("user", "how are you"),
      makeMessage("system", "system info"),
      makeMessage("tool", "tool result"),
    ];
    expect(extractUserEntries(messages)).toEqual(["hello", "how are you"]);
  });

  test("preserves order of user messages", () => {
    const messages: DisplayMessage[] = [
      makeMessage("user", "first"),
      makeMessage("assistant", "response"),
      makeMessage("user", "second"),
      makeMessage("assistant", "response2"),
      makeMessage("user", "third"),
    ];
    expect(extractUserEntries(messages)).toEqual(["first", "second", "third"]);
  });

  test("returns empty array when no user messages exist", () => {
    const messages: DisplayMessage[] = [
      makeMessage("assistant", "hello"),
      makeMessage("system", "info"),
    ];
    expect(extractUserEntries(messages)).toEqual([]);
  });
});

describe("navigateIndex", () => {
  describe("up direction", () => {
    test("returns undefined when entries is empty", () => {
      expect(navigateIndex(0, 0, "up")).toBeUndefined();
    });

    test("moves from present to last entry", () => {
      // entriesLength=3, currentIndex=3 (at present)
      expect(navigateIndex(3, 3, "up")).toBe(2);
    });

    test("moves up through entries", () => {
      expect(navigateIndex(3, 2, "up")).toBe(1);
      expect(navigateIndex(3, 1, "up")).toBe(0);
    });

    test("returns undefined at oldest entry", () => {
      expect(navigateIndex(3, 0, "up")).toBeUndefined();
    });

    test("works with single entry", () => {
      // From present
      expect(navigateIndex(1, 1, "up")).toBe(0);
      // Already at oldest
      expect(navigateIndex(1, 0, "up")).toBeUndefined();
    });
  });

  describe("down direction", () => {
    test("returns undefined when at present", () => {
      expect(navigateIndex(3, 3, "down")).toBeUndefined();
    });

    test("moves down through entries", () => {
      expect(navigateIndex(3, 0, "down")).toBe(1);
      expect(navigateIndex(3, 1, "down")).toBe(2);
    });

    test("moves from last entry back to present", () => {
      expect(navigateIndex(3, 2, "down")).toBe(3);
    });

    test("returns undefined when already past entries", () => {
      expect(navigateIndex(3, 3, "down")).toBeUndefined();
      expect(navigateIndex(0, 0, "down")).toBeUndefined();
    });

    test("works with single entry", () => {
      // From the entry back to present
      expect(navigateIndex(1, 0, "down")).toBe(1);
      // At present
      expect(navigateIndex(1, 1, "down")).toBeUndefined();
    });
  });
});

describe("getValueAtIndex", () => {
  const entries = ["first", "second", "third"];
  const draft = "my draft";

  test("returns entry at valid index", () => {
    expect(getValueAtIndex(entries, 0, draft)).toBe("first");
    expect(getValueAtIndex(entries, 1, draft)).toBe("second");
    expect(getValueAtIndex(entries, 2, draft)).toBe("third");
  });

  test("returns draft when index equals entries.length (present)", () => {
    expect(getValueAtIndex(entries, 3, draft)).toBe("my draft");
  });

  test("returns draft when index exceeds entries.length", () => {
    expect(getValueAtIndex(entries, 5, draft)).toBe("my draft");
  });

  test("returns draft for empty entries", () => {
    expect(getValueAtIndex([], 0, "typing")).toBe("typing");
  });

  test("returns empty draft", () => {
    expect(getValueAtIndex(entries, 3, "")).toBe("");
  });
});

describe("mergeNewEntries", () => {
  test("appends all entries when existing is empty", () => {
    expect(mergeNewEntries([], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("returns same reference when no new entries", () => {
    const existing = ["a", "b"];
    expect(mergeNewEntries(existing, ["a", "b"])).toBe(existing);
  });

  test("returns same reference when fromMessages is empty", () => {
    const existing = ["a", "b"];
    expect(mergeNewEntries(existing, [])).toBe(existing);
  });

  test("only appends entries not already present", () => {
    expect(mergeNewEntries(["a", "b"], ["b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  test("preserves existing order and appends new at end", () => {
    expect(mergeNewEntries(["x", "y"], ["a", "b"])).toEqual(["x", "y", "a", "b"]);
  });

  test("handles duplicates within fromMessages", () => {
    // "a" appears twice in fromMessages but is already in existing
    expect(mergeNewEntries(["a"], ["a", "b", "a"])).toEqual(["a", "b"]);
  });

  test("accumulates across multiple merges (simulates session switches)", () => {
    const after1 = mergeNewEntries([], ["hello", "world"]);
    // Simulate /clear — messages becomes [] but existing history preserved
    const after2 = mergeNewEntries(after1, []);
    expect(after2).toBe(after1); // same reference, no change
    // New session messages arrive
    const after3 = mergeNewEntries(after2, ["new question"]);
    expect(after3).toEqual(["hello", "world", "new question"]);
  });
});
