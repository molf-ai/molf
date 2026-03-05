import { describe, test, expect } from "bun:test";
import { truncateOutput, TRUNCATION_MAX_LINES, TRUNCATION_MAX_BYTES } from "../src/truncation.js";

describe("truncateOutput", () => {
  test("returns unchanged when below both thresholds", () => {
    const text = "line1\nline2\nline3";
    const result = truncateOutput(text);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(text);
    expect(result.removedLines).toBeUndefined();
  });

  test("returns unchanged for empty string", () => {
    const result = truncateOutput("");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("");
  });

  test("truncates when exceeding line limit", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBe(TRUNCATION_MAX_LINES);
    expect(result.removedLines).toBe(500);
  });

  test("truncates when exceeding byte limit", () => {
    // Create text that fits in line count but exceeds byte limit
    // Each line ~100 bytes, 1000 lines = ~100KB > 50KB limit
    const lines = Array.from({ length: 1000 }, (_, i) => "x".repeat(99) + i.toString().padStart(1));
    const text = lines.join("\n");

    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(TRUNCATION_MAX_BYTES);

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES);
    expect(result.removedLines).toBeGreaterThan(0);
  });

  test("truncates at line boundary when byte limit hit", () => {
    const lines = Array.from({ length: 1000 }, () => "x".repeat(200));
    const text = lines.join("\n");

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    // Should be complete lines (no partial line)
    const resultLines = result.content.split("\n");
    for (const line of resultLines) {
      expect(line).toBe("x".repeat(200));
    }
  });

  test("byte-truncates single oversized line instead of passing it through", () => {
    const text = "x".repeat(TRUNCATION_MAX_BYTES + 1000);
    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES);
    expect(result.removedLines).toBe(0);
  });

  test("byte-truncates single oversized line with multi-byte chars cleanly", () => {
    // 20000 emojis * 4 bytes each = 80KB > 50KB limit, all on one line
    const text = "\u{1F600}".repeat(20000);
    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES);
    // Should not end with replacement character
    expect(result.content.endsWith("\uFFFD")).toBe(false);
  });

  test("respects custom maxLines option", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");

    const result = truncateOutput(text, { maxLines: 10 });

    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBe(10);
    expect(result.removedLines).toBe(10);
  });

  test("respects custom maxBytes option", () => {
    const lines = Array.from({ length: 100 }, () => "x".repeat(50));
    const text = lines.join("\n");

    const result = truncateOutput(text, { maxBytes: 500 });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(500);
  });

  test("handles UTF-8 multi-byte characters correctly", () => {
    // Each emoji is 4 bytes in UTF-8; 500 lines * 100 emojis * 4 bytes = 200KB
    const lines = Array.from({ length: 500 }, () => "\u{1F600}".repeat(100));
    const text = lines.join("\n");

    const byteLength = Buffer.byteLength(text, "utf-8");
    expect(byteLength).toBeGreaterThan(TRUNCATION_MAX_BYTES);

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    // Verify no broken multi-byte characters by re-encoding
    const decoded = Buffer.from(result.content, "utf-8").toString("utf-8");
    expect(decoded).toBe(result.content);
  });

  test("line limit takes priority when both limits would be exceeded", () => {
    // 10 lines of 10KB each = 100KB total > 50KB byte limit
    // But set maxLines to 3 which hits first
    const lines = Array.from({ length: 10 }, () => "x".repeat(10000));
    const text = lines.join("\n");

    const result = truncateOutput(text, { maxLines: 3 });

    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBe(3);
    expect(result.removedLines).toBe(7);
  });

  test("exact line limit boundary - not truncated", () => {
    const lines = Array.from({ length: TRUNCATION_MAX_LINES }, (_, i) => `line ${i}`);
    const text = lines.join("\n");

    const result = truncateOutput(text);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(text);
  });

  test("one over line limit - truncated", () => {
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 1 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBe(TRUNCATION_MAX_LINES);
    expect(result.removedLines).toBe(1);
  });

  test("simultaneous line and byte limits — byte limit wins", () => {
    // 100 lines of 1KB each = 100KB > 50KB byte limit, but under default 2000 line limit
    // Byte limit should kick in first
    const lines = Array.from({ length: 100 }, (_, i) => `${i}:${"A".repeat(1000)}`);
    const text = lines.join("\n");

    expect(lines.length).toBeLessThan(TRUNCATION_MAX_LINES);
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(TRUNCATION_MAX_BYTES);

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    const resultLines = result.content.split("\n");
    expect(resultLines.length).toBeLessThan(100);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES);
    expect(result.removedLines).toBe(100 - resultLines.length);
  });

  test("simultaneous line and byte limits — line limit wins", () => {
    // 2500 very short lines (5 bytes each) = ~15KB < 50KB byte limit
    // Line limit should kick in first
    const lines = Array.from({ length: 2500 }, (_, i) => `L${i}`);
    const text = lines.join("\n");

    expect(lines.length).toBeGreaterThan(TRUNCATION_MAX_LINES);
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(TRUNCATION_MAX_BYTES);

    const result = truncateOutput(text);

    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBe(TRUNCATION_MAX_LINES);
    expect(result.removedLines).toBe(2500 - TRUNCATION_MAX_LINES);
  });

  test("simultaneous custom line and byte limits", () => {
    // 20 lines of 100 bytes each. maxLines=5, maxBytes=300
    // Both limits configured; whichever is stricter wins per-case
    const lines = Array.from({ length: 20 }, (_, i) => `${i}:${"x".repeat(95)}`);
    const text = lines.join("\n");

    const result = truncateOutput(text, { maxLines: 5, maxBytes: 300 });

    expect(result.truncated).toBe(true);
    const resultLines = result.content.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(300);
  });
});
