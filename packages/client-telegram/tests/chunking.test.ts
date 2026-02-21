import { describe, it, expect } from "bun:test";
import { splitIntoChunks, MESSAGE_CHAR_LIMIT } from "../src/chunking.js";

describe("splitIntoChunks", () => {
  it("returns single chunk for short text", () => {
    const result = splitIntoChunks("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("returns single chunk at exactly the limit", () => {
    const text = "a".repeat(MESSAGE_CHAR_LIMIT);
    const result = splitIntoChunks(text);
    expect(result).toEqual([text]);
  });

  it("splits at paragraph break", () => {
    const part1 = "a".repeat(3000);
    const part2 = "b".repeat(2000);
    const text = `${part1}\n\n${part2}`;
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
  });

  it("splits at single newline when no paragraph break", () => {
    const part1 = "a".repeat(3000);
    const part2 = "b".repeat(2000);
    const text = `${part1}\n${part2}`;
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
  });

  it("splits at sentence end", () => {
    const sentence1 = "a".repeat(3000) + ". ";
    const sentence2 = "b".repeat(2000);
    const text = sentence1 + sentence2;
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
  });

  it("does hard cut when no logical break found", () => {
    const text = "a".repeat(MESSAGE_CHAR_LIMIT + 100);
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(MESSAGE_CHAR_LIMIT);
    expect(result[1].length).toBe(100);
  });

  it("handles multiple chunks", () => {
    const text = "a".repeat(MESSAGE_CHAR_LIMIT * 3);
    const result = splitIntoChunks(text);
    expect(result.length).toBe(3);
  });

  it("respects custom limit", () => {
    const text = "a".repeat(200);
    const result = splitIntoChunks(text, { limit: 100 });
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(100);
    expect(result[1].length).toBe(100);
  });

  it("does not split inside code fences", () => {
    const before = "x".repeat(3500);
    const codeBlock = "```\ncode line 1\ncode line 2\n```";
    const after = "y".repeat(100);
    const text = `${before}\n${codeBlock}\n${after}`;

    const result = splitIntoChunks(text);
    // The code block should not be split
    const joined = result.join("");
    expect(joined).toContain("code line 1");
    expect(joined).toContain("code line 2");

    // Verify no chunk has a partial code block
    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      // A chunk should have either 0 or 2 triple-backtick markers (balanced)
      expect(opens % 2).toBe(0);
    }
  });

  it("handles empty string", () => {
    const result = splitIntoChunks("");
    expect(result).toEqual([]);
  });

  it("handles whitespace-only text", () => {
    const result = splitIntoChunks("   ");
    expect(result).toEqual(["   "]);
  });

  it("prefers paragraph break over newline", () => {
    // Place a paragraph break and a single newline both within the window
    const before = "a".repeat(2000);
    const middle = "b".repeat(500);
    const after = "c".repeat(2000);
    const text = `${before}\n\n${middle}\n${after}`;
    const result = splitIntoChunks(text);
    // Should split at the paragraph break (\n\n) rather than at the newline
    expect(result[0]).toBe(before);
  });

  it("splits before code fence when fence is near limit", () => {
    // Code fence starts near the limit boundary
    const before = "x".repeat(3800);
    const code = "\n```\nfoo\nbar\nbaz\n```\n";
    const after = "y".repeat(100);
    const text = before + code + after;
    const result = splitIntoChunks(text);

    // First chunk should not contain the opening fence
    // or the code block should be intact in a single chunk
    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("handles very large code block that exceeds limit", () => {
    // A code block that by itself is larger than the limit
    const codeContent = "x".repeat(MESSAGE_CHAR_LIMIT + 500);
    const text = "```\n" + codeContent + "\n```";
    const result = splitIntoChunks(text);
    // Should still produce chunks without hanging
    expect(result.length).toBeGreaterThan(0);
    const totalLength = result.reduce((sum, c) => sum + c.length, 0);
    // All content preserved (whitespace trimming may reduce slightly)
    expect(totalLength).toBeGreaterThan(MESSAGE_CHAR_LIMIT);
  });

  it("handles text with only a paragraph break", () => {
    const text = "hello\n\nworld";
    const result = splitIntoChunks(text, { limit: 8 });
    expect(result.length).toBe(2);
    expect(result[0]).toBe("hello");
    expect(result[1]).toBe("world");
  });

  it("handles text just over the limit with a late break", () => {
    // Break point is in the last 30% of the window — should still use it
    const part1 = "a".repeat(3500);
    const text = `${part1}\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb${"c".repeat(1000)}`;
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(part1);
  });

  it("cuts before fence when inside unclosed fence with break available", () => {
    // Content before the fence with a newline break point, then an unclosed fence at the limit
    const before = "a".repeat(2000) + "\n" + "b".repeat(1500);
    const fencedCode = "\n```\n" + "c".repeat(1000) + "\n```";
    const text = before + fencedCode;
    const result = splitIntoChunks(text);

    // Code block should be intact in one of the chunks
    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("handles fence starting at position 0 with closing fence within range", () => {
    // Code block starts at the very beginning of the text
    const code = "```\n" + "x".repeat(200) + "\n```\n";
    const after = "y".repeat(MESSAGE_CHAR_LIMIT);
    const text = code + after;
    const result = splitIntoChunks(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain the complete code block
    expect(result[0]).toContain("```");
    const opens = (result[0].match(/```/g) || []).length;
    expect(opens % 2).toBe(0);
  });

  it("handles fence starting at position 0 with closing fence beyond 2x limit", () => {
    // Code block starts at beginning and closing fence is very far away
    const code = "```\n" + "x".repeat(MESSAGE_CHAR_LIMIT * 2 + 500) + "\n```";
    const result = splitIntoChunks(code);

    // Must produce chunks (shouldn't hang)
    expect(result.length).toBeGreaterThan(0);
    const totalLength = result.reduce((sum, c) => sum + c.length, 0);
    expect(totalLength).toBeGreaterThan(MESSAGE_CHAR_LIMIT * 2);
  });

  it("findBreakBefore uses paragraph break when available", () => {
    // Content with a paragraph break before the fence, then the fence near the limit
    const part1 = "a".repeat(1500);
    const part2 = "b".repeat(1500);
    const fencedCode = "```\n" + "c".repeat(2000) + "\n```";
    const text = part1 + "\n\n" + part2 + "\n" + fencedCode;
    const result = splitIntoChunks(text);

    // Should split at the paragraph break before the fence
    expect(result[0]).toBe(part1);
  });

  it("findBreakBefore uses single newline when no paragraph break", () => {
    // Content with only single newlines before the fence
    const part1 = "a".repeat(2000);
    const part2 = "b".repeat(1500);
    const fencedCode = "```\n" + "c".repeat(2000) + "\n```";
    const text = part1 + "\n" + part2 + fencedCode;
    const result = splitIntoChunks(text);

    // Should split at the single newline
    expect(result[0]).toBe(part1);
  });

  it("findBreakBefore returns 0 when no break found in early portion", () => {
    // Fence starts early with no breaks in the first 30%
    const before = "a".repeat(100);
    const fencedCode = "```\n" + "b".repeat(4500) + "\n```";
    const text = before + fencedCode;
    const result = splitIntoChunks(text);

    // Should still produce valid chunks
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles closing fence on last line without trailing newline", () => {
    // Fence where closing ``` has no newline after it
    const before = "x".repeat(3500) + "\n";
    const code = "```\ncode here\n```";
    const text = before + code;
    const result = splitIntoChunks(text);

    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("handles multiple code fences with opening and closing pairs", () => {
    // Two complete code blocks that together exceed the limit
    const block1 = "```\n" + "a".repeat(2000) + "\n```\n";
    const block2 = "```\n" + "b".repeat(2000) + "\n```\n";
    const text = block1 + block2;
    const result = splitIntoChunks(text);

    // Each chunk should have balanced fences
    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("never produces chunks exceeding the limit", () => {
    // Code fence starts at position 0 with content that exceeds the limit
    // Previously this could produce chunks up to 2x limit (8000 chars)
    const codeContent = "x".repeat(5000);
    const text = "```\n" + codeContent + "\n```\nafter";
    const result = splitIntoChunks(text);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(MESSAGE_CHAR_LIMIT);
    }
  });

  it("all break types too early (< 30%) falls through to hard cut", () => {
    // Put the only break point very early, forcing hard cut
    const text = "a\n" + "b".repeat(MESSAGE_CHAR_LIMIT + 100);
    const result = splitIntoChunks(text);
    expect(result.length).toBe(2);
    // The newline is at position 1, which is < 30% of limit, so hard cut at limit
    expect(result[0].length).toBe(MESSAGE_CHAR_LIMIT);
  });
});
