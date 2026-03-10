import { describe, it, expect } from "vitest";
import { parseFenceSpans, findFenceSpanAt, isSafeFenceBreak } from "../src/fences.js";

describe("parseFenceSpans", () => {
  it("parses a single complete code fence", () => {
    const text = "before\n```js\ncode here\n```\nafter";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].openLine).toBe("```js");
    expect(spans[0].marker).toBe("```");
  });

  it("parses multiple code fences", () => {
    const text = "```\nfirst\n```\ntext\n```py\nsecond\n```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(2);
  });

  it("handles unclosed fence as spanning to end", () => {
    const text = "before\n```js\ncode here\nmore code";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(text.length);
  });

  it("parses tilde fences", () => {
    const text = "~~~\ncode\n~~~";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].marker).toBe("~~~");
  });

  it("requires matching marker char for closing", () => {
    // Opening with backticks, trying to close with tildes should not close
    const text = "```\ncode\n~~~\nmore";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    // Should be unclosed (spans to end)
    expect(spans[0].end).toBe(text.length);
  });

  it("requires closing marker length >= opening length", () => {
    const text = "````\ncode\n```\nstill inside\n````";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    // Closed by the 4-backtick closer
    expect(spans[0].openLine).toBe("````");
  });

  it("returns empty for text without fences", () => {
    const spans = parseFenceSpans("just plain text\nwith newlines");
    expect(spans).toHaveLength(0);
  });

  it("captures indent", () => {
    const text = "  ```js\n  code\n  ```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].indent).toBe("  ");
  });
});

describe("findFenceSpanAt", () => {
  it("returns the fence span at a given index", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    // Index inside the fence content
    const insideIdx = text.indexOf("code");
    const found = findFenceSpanAt(spans, insideIdx);
    expect(found).toBeDefined();
  });

  it("returns undefined outside any fence", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    const outsideIdx = text.indexOf("after");
    const found = findFenceSpanAt(spans, outsideIdx);
    expect(found).toBeUndefined();
  });
});

describe("isSafeFenceBreak", () => {
  it("returns true outside fence", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    const outsideIdx = text.indexOf("after");
    expect(isSafeFenceBreak(spans, outsideIdx)).toBe(true);
  });

  it("returns false inside fence", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    const insideIdx = text.indexOf("code");
    expect(isSafeFenceBreak(spans, insideIdx)).toBe(false);
  });

  it("returns true when no fences exist", () => {
    const spans = parseFenceSpans("plain text");
    expect(isSafeFenceBreak(spans, 5)).toBe(true);
  });
});
