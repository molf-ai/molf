import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync } from "fs";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { readFileTool } from "../../src/tools/read-file.js";

let tmp: TmpDir;
beforeAll(() => {
  tmp = createTmpDir();
  tmp.writeFile("test.txt", "line1\nline2\nline3");
});
afterAll(() => tmp.cleanup());

describe("readFileTool", () => {
  test("read existing file", async () => {
    const result = await readFileTool.execute!(
      { path: `${tmp.path}/test.txt` } as any,
      {} as any,
    );
    expect((result as any).content).toContain("line1");
  });

  test("read nonexistent file", async () => {
    const result = await readFileTool.execute!(
      { path: `${tmp.path}/nope.txt` } as any,
      {} as any,
    );
    expect((result as any).error).toContain("not found");
  });

  test("read with startLine and endLine", async () => {
    const result = await readFileTool.execute!(
      { path: `${tmp.path}/test.txt`, startLine: 2, endLine: 2 } as any,
      {} as any,
    );
    expect((result as any).content).toBe("line2");
  });

  test("truncate content exceeding MAX_CONTENT_LENGTH", async () => {
    const longContent = "x".repeat(200_000);
    tmp.writeFile("long.txt", longContent);
    const result = await readFileTool.execute!(
      { path: `${tmp.path}/long.txt` } as any,
      {} as any,
    );
    expect((result as any).truncated).toBe(true);
    expect((result as any).content.length).toBe(100_000);
  });

  test("error on non-ENOENT failure", async () => {
    // Create a file with no read permissions to trigger a non-ENOENT error
    const noReadPath = `${tmp.path}/noread.txt`;
    tmp.writeFile("noread.txt", "secret");
    chmodSync(noReadPath, 0o000);
    try {
      const result = await readFileTool.execute!(
        { path: noReadPath } as any,
        {} as any,
      );
      expect((result as any).error).toContain("Failed to read file:");
    } finally {
      chmodSync(noReadPath, 0o644);
    }
  });
});
