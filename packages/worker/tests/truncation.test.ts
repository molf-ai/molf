import { describe, test, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { truncateAndStore, isSafeToolCallId } from "../src/truncation.js";
import { TRUNCATION_MAX_LINES } from "@molf-ai/protocol";

const TEST_DIR = resolve(import.meta.dir, "../.test-workdir-trunc");
const OUTPUT_DIR = resolve(TEST_DIR, ".molf/tool-output");

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("truncateAndStore", () => {
  test("small output passes through unchanged", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const result = await truncateAndStore("hello world", "tc-1", TEST_DIR);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello world");
    expect(result.outputId).toBeUndefined();
    expect(result.outputPath).toBeUndefined();
  });

  test("large output is truncated and saved to disk", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 500 }, (_, i) => `line ${i}`);
    const bigText = lines.join("\n");

    const result = await truncateAndStore(bigText, "tc-2", TEST_DIR);
    expect(result.truncated).toBe(true);
    expect(result.outputId).toBe("tc-2");
    expect(result.outputPath).toBe(resolve(OUTPUT_DIR, "tc-2.txt"));

    // Full output saved to disk
    expect(existsSync(result.outputPath!)).toBe(true);
    const saved = readFileSync(result.outputPath!, "utf-8");
    expect(saved).toBe(bigText);

    // Truncated content has hint
    expect(result.content).toContain("lines truncated");
    expect(result.content).toContain("read_file");
    expect(result.content).toContain(result.outputPath!);
  });

  test("creates output directory if it does not exist", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const bigText = lines.join("\n");

    expect(existsSync(OUTPUT_DIR)).toBe(false);
    const result = await truncateAndStore(bigText, "tc-3", TEST_DIR);
    expect(result.truncated).toBe(true);
    expect(existsSync(OUTPUT_DIR)).toBe(true);
  });

  test("graceful fallback when file write fails", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Create a file where the directory should be, so mkdir for .molf/tool-output fails
    const { writeFileSync } = await import("fs");
    writeFileSync(resolve(TEST_DIR, ".molf"), "file-not-dir");

    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const bigText = lines.join("\n");

    const result = await truncateAndStore(bigText, "tc-4", TEST_DIR);
    expect(result.truncated).toBe(true);
    expect(result.outputId).toBeUndefined();
    expect(result.outputPath).toBeUndefined();
    expect(result.content).toContain("lines truncated");
    // No hint about saved file since write failed
    expect(result.content).not.toContain("read_file");
  });

  test("hint message contains correct file path", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => `x${i}`);
    const bigText = lines.join("\n");

    const result = await truncateAndStore(bigText, "my-call-id", TEST_DIR);
    expect(result.content).toContain("my-call-id.txt");
    expect(result.content).toContain("Full output saved to:");
    expect(result.content).toContain("grep");
  });

  test("unsafe toolCallId with path traversal skips file storage", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const bigText = lines.join("\n");

    const result = await truncateAndStore(bigText, "../../../etc/passwd", TEST_DIR);
    expect(result.truncated).toBe(true);
    expect(result.outputId).toBeUndefined();
    expect(result.outputPath).toBeUndefined();
    expect(result.content).toContain("lines truncated");
    expect(result.content).not.toContain("read_file");
  });

  test("unsafe toolCallId with slashes skips file storage", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lines = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const bigText = lines.join("\n");

    const result = await truncateAndStore(bigText, "foo/bar", TEST_DIR);
    expect(result.truncated).toBe(true);
    expect(result.outputId).toBeUndefined();
    expect(result.outputPath).toBeUndefined();
  });
});

describe("isSafeToolCallId", () => {
  test("accepts alphanumeric with hyphens and underscores", () => {
    expect(isSafeToolCallId("abc-123_DEF")).toBe(true);
    expect(isSafeToolCallId("call_toolu_abc123")).toBe(true);
  });

  test("rejects path traversal", () => {
    expect(isSafeToolCallId("../etc/passwd")).toBe(false);
    expect(isSafeToolCallId("..")).toBe(false);
  });

  test("rejects slashes", () => {
    expect(isSafeToolCallId("foo/bar")).toBe(false);
    expect(isSafeToolCallId("foo\\bar")).toBe(false);
  });

  test("rejects spaces and special characters", () => {
    expect(isSafeToolCallId("foo bar")).toBe(false);
    expect(isSafeToolCallId("foo;rm -rf")).toBe(false);
    expect(isSafeToolCallId("")).toBe(false);
  });
});
