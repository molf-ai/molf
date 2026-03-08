import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

const { readFileTool } = await import("../src/tools/read-file.js");

let tmp: TmpDir;

beforeAll(() => {
  tmp = createTmpDir("molf-read-file-");
});

afterAll(() => tmp.cleanup());

const executeRaw = readFileTool.execute!;
const execute = (args: { path: string; startLine?: number; endLine?: number }) =>
  executeRaw(args as any, { toolCallId: "", workdir: tmp.path } as any);

describe("read-file boundary cases", () => {
  test("empty file returns output with totalLines 1", async () => {
    const filePath = resolve(tmp.path, "empty.txt");
    await Bun.write(filePath, "");

    const result = await execute({ path: filePath });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("(1 lines)");
    expect(result.meta?.truncated).toBe(false);
  });

  test("file not found returns error", async () => {
    const result = await execute({ path: resolve(tmp.path, "nonexistent.txt") });
    expect(result.error).toContain("File not found");
  });

  test("binary file detected by content analysis returns error", async () => {
    const filePath = resolve(tmp.path, "mystery.dat2");
    const bytes = new Uint8Array(100);
    bytes.fill(0);
    await Bun.write(filePath, bytes);

    const result = await execute({ path: filePath });
    expect(result.error).toContain("Cannot read binary file");
  });

  test("binary detection threshold — file just below threshold is readable", async () => {
    const filePath = resolve(tmp.path, "mostly-text.dat2");
    const bytes = new Uint8Array(100);
    bytes.fill(65); // 'A'
    for (let i = 0; i < 29; i++) {
      bytes[i] = 1; // non-printable but not null
    }
    await Bun.write(filePath, bytes);

    const result = await execute({ path: filePath });
    expect(result.error).toBeUndefined();
    expect(result.output).toBeTruthy();
  });

  test("file with null byte is detected as binary", async () => {
    const filePath = resolve(tmp.path, "has-null.dat2");
    const bytes = new Uint8Array(100);
    bytes.fill(65); // 'A'
    bytes[50] = 0; // single null byte
    await Bun.write(filePath, bytes);

    const result = await execute({ path: filePath });
    expect(result.error).toContain("Cannot read binary file");
  });

  test("known binary extension (.png) returns attachment", async () => {
    const filePath = resolve(tmp.path, "test.png");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    await Bun.write(filePath, bytes);

    const result = await execute({ path: filePath });
    expect(result.error).toBeUndefined();
    expect(result.attachments).toBeDefined();
    expect(result.attachments![0].mimeType).toBe("image/png");
    expect(result.attachments![0].data).toBeTruthy(); // base64
    expect(result.attachments![0].size).toBe(4);
  });

  test("opaque binary extension (.zip) returns error", async () => {
    const filePath = resolve(tmp.path, "archive.zip");
    await Bun.write(filePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    const result = await execute({ path: filePath });
    expect(result.error).toContain("Cannot read binary file");
    expect(result.error).toContain(".zip");
  });

  test("text file exceeding MAX_CONTENT_LENGTH is truncated", async () => {
    const filePath = resolve(tmp.path, "big.txt");
    const content = "x".repeat(150_000);
    await Bun.write(filePath, content);

    const result = await execute({ path: filePath });
    expect(result.error).toBeUndefined();
    expect(result.meta?.truncated).toBe(true);
  });

  test("line range selection works correctly", async () => {
    const filePath = resolve(tmp.path, "lines.txt");
    await Bun.write(filePath, "line1\nline2\nline3\nline4\nline5\n");

    const result = await execute({ path: filePath, startLine: 2, endLine: 4 });
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("line2\nline3\nline4");
  });
});
