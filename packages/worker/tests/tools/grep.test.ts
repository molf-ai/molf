import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { grepTool } from "../../src/tools/grep.js";
import { createTmpDir } from "@molf-ai/test-utils";
import { join } from "path";
import { mkdir } from "node:fs/promises";

describe("grepTool", () => {
  let tmpDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTmpDir();
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  async function writeFile(relPath: string, content: string): Promise<string> {
    const filePath = join(tmpDir, relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
    return filePath;
  }

  test("finds matching lines", async () => {
    await writeFile("file.ts", "const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n");

    const result = (await grepTool.execute!(
      { pattern: "foo", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBeGreaterThanOrEqual(2);
    const texts = result.matches.map((m: any) => m.text.trim());
    expect(texts).toContain("const foo = 1;");
    expect(texts).toContain("const foobar = 3;");
  });

  test("empty results", async () => {
    await writeFile("file.ts", "hello world\n");

    const result = (await grepTool.execute!(
      { pattern: "zzzznotfound", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  test("respects include filter", async () => {
    await writeFile("a.ts", "match here\n");
    await writeFile("b.js", "match here\n");

    const result = (await grepTool.execute!(
      { pattern: "match", path: tmpDir, include: "*.ts" } as any,
      {} as any,
    )) as any;

    const files = result.matches.map((m: any) => m.file);
    expect(files.some((f: string) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f: string) => f.endsWith("b.js"))).toBe(false);
  });

  test("respects path", async () => {
    await writeFile("src/a.ts", "target line\n");
    await writeFile("lib/b.ts", "target line\n");

    const result = (await grepTool.execute!(
      { pattern: "target", path: join(tmpDir, "src") } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(1);
    expect(result.matches[0].file).toContain("a.ts");
  });

  test("truncates long lines", async () => {
    const longLine = "x".repeat(1000);
    await writeFile("long.txt", `${longLine}\n`);

    const result = (await grepTool.execute!(
      { pattern: "x", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].text.length).toBeLessThanOrEqual(500);
  });

  test("handles regex patterns", async () => {
    await writeFile("re.txt", "abc123\ndef456\nabc789\n");

    const result = (await grepTool.execute!(
      { pattern: "abc\\d+", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(2);
  });

  test("error on nonexistent path", async () => {
    const result = (await grepTool.execute!(
      { pattern: "foo", path: "/nonexistent/path/xyz" } as any,
      {} as any,
    )) as any;

    expect(result.error).toContain("not found");
  });

  test("handles filenames containing pipe character", async () => {
    await writeFile("file|pipe.txt", "match here\n");

    const result = (await grepTool.execute!(
      { pattern: "match", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(1);
    expect(result.matches[0].file).toContain("file|pipe.txt");
    expect(result.matches[0].text.trim()).toBe("match here");
  });

  test("matches have correct line numbers", async () => {
    await writeFile("lines.txt", "line1\nline2\ntarget\nline4\n");

    const result = (await grepTool.execute!(
      { pattern: "target", path: tmpDir } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(1);
    expect(result.matches[0].line).toBe(3);
  });
});
