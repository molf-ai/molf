import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { globTool } from "../../src/tools/glob.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { join } from "path";
import { utimes } from "node:fs/promises";

describe("globTool", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = createTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  test("match by extension", async () => {
    tmp.writeFile("a.ts", "");
    tmp.writeFile("b.ts", "");
    tmp.writeFile("c.js", "");

    const result = (await globTool.execute!(
      { pattern: "*.ts", path: tmp.path } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(2);
    expect(result.files).toContain("a.ts");
    expect(result.files).toContain("b.ts");
    expect(result.files).not.toContain("c.js");
  });

  test("recursive pattern", async () => {
    tmp.writeFile("src/a.ts", "");
    tmp.writeFile("src/nested/b.ts", "");
    tmp.writeFile("lib/c.ts", "");

    const result = (await globTool.execute!(
      { pattern: "**/*.ts", path: tmp.path } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(3);
  });

  test("empty results", async () => {
    const result = (await globTool.execute!(
      { pattern: "*.xyz", path: tmp.path } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("respects path param", async () => {
    tmp.writeFile("src/a.ts", "");
    tmp.writeFile("lib/b.ts", "");

    const result = (await globTool.execute!(
      { pattern: "*.ts", path: join(tmp.path, "src") } as any,
      {} as any,
    )) as any;

    expect(result.count).toBe(1);
    expect(result.files).toContain("a.ts");
  });

  test("skips dot files by default", async () => {
    tmp.writeFile(".hidden", "");
    tmp.writeFile("visible.txt", "");

    const result = (await globTool.execute!(
      { pattern: "*", path: tmp.path } as any,
      {} as any,
    )) as any;

    expect(result.files).toContain("visible.txt");
    expect(result.files).not.toContain(".hidden");
  });

  test("error on invalid directory", async () => {
    const result = (await globTool.execute!(
      { pattern: "*.ts", path: "/nonexistent/path/xyz" } as any,
      {} as any,
    )) as any;

    expect(result.error).toContain("not found");
  });

  test("results sorted by mtime (newest first)", async () => {
    const fileA = tmp.writeFile("a.ts", "aaa");
    const fileB = tmp.writeFile("b.ts", "bbb");

    // Set a.ts to be older than b.ts
    const old = new Date(2000, 0, 1);
    const recent = new Date(2024, 0, 1);
    await utimes(fileA, old, old);
    await utimes(fileB, recent, recent);

    const result = (await globTool.execute!(
      { pattern: "*.ts", path: tmp.path } as any,
      {} as any,
    )) as any;

    expect(result.files[0]).toBe("b.ts");
    expect(result.files[1]).toBe("a.ts");
  });
});
