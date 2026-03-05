import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { grepHandler } from "../../src/tools/grep.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { join } from "path";
import { mkdir } from "node:fs/promises";
import type { ToolHandlerContext } from "@molf-ai/protocol";

const ctx: ToolHandlerContext = { toolCallId: "tc_grep", workdir: "/tmp" };

describe("grepHandler", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = createTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  async function writeFile(relPath: string, content: string | Uint8Array): Promise<string> {
    const filePath = join(tmp.path, relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
    return filePath;
  }

  test("finds matching lines", async () => {
    await writeFile("file.ts", "const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n");

    const result = await grepHandler(
      { pattern: "foo", path: tmp.path },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("const foo = 1;");
    expect(result.output).toContain("const foobar = 3;");
  });

  test("empty results", async () => {
    await writeFile("file.ts", "hello world\n");

    const result = await grepHandler(
      { pattern: "zzzznotfound", path: tmp.path },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toBe("No matches found");
  });

  test("respects include filter", async () => {
    await writeFile("a.ts", "match here\n");
    await writeFile("b.js", "match here\n");

    const result = await grepHandler(
      { pattern: "match", path: tmp.path, include: "*.ts" },
      ctx,
    );

    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("b.js");
  });

  test("respects path", async () => {
    await writeFile("src/a.ts", "target line\n");
    await writeFile("lib/b.ts", "target line\n");

    const result = await grepHandler(
      { pattern: "target", path: join(tmp.path, "src") },
      ctx,
    );

    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("b.ts");
  });

  test("handles regex patterns", async () => {
    await writeFile("re.txt", "abc123\ndef456\nabc789\n");

    const result = await grepHandler(
      { pattern: "abc\\d+", path: tmp.path },
      ctx,
    );

    expect(result.output).toContain("abc123");
    expect(result.output).toContain("abc789");
  });

  test("error on nonexistent path", async () => {
    const result = await grepHandler(
      { pattern: "foo", path: "/nonexistent/path/xyz" },
      ctx,
    );

    expect(result.error).toContain("not found");
  });

  test("matches have correct line numbers", async () => {
    await writeFile("lines.txt", "line1\nline2\ntarget\nline4\n");

    const result = await grepHandler(
      { pattern: "target", path: tmp.path },
      ctx,
    );

    expect(result.output).toContain(":3:");
  });

  test("case-insensitive search via regex flag", async () => {
    await writeFile("case.txt", "Hello World\nhello world\nHELLO WORLD\n");

    // ripgrep supports (?i) inline flag for case-insensitive matching
    const result = await grepHandler(
      { pattern: "(?i)hello", path: tmp.path },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Hello World");
    expect(result.output).toContain("hello world");
    expect(result.output).toContain("HELLO WORLD");
  });

  test("binary file in grep path does not produce errors", async () => {
    // Create a binary file alongside a text file
    const binaryData = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binaryData[i] = i;
    await writeFile("binary.bin", binaryData);
    await writeFile("text.txt", "findme here\n");

    const result = await grepHandler(
      { pattern: "findme", path: tmp.path },
      ctx,
    );

    // Should find the text match and not error on binary file
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("findme here");
    expect(result.output).toContain("text.txt");
  });
});
