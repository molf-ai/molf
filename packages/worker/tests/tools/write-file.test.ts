import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { writeFileTool } from "../../src/tools/write-file.js";

let tmp: TmpDir;
beforeAll(() => {
  tmp = createTmpDir();
});
afterAll(() => tmp.cleanup());

describe("writeFileTool", () => {
  test("write new file", async () => {
    const path = `${tmp.path}/output.txt`;
    const result = await writeFileTool.execute!(
      { path, content: "hello world" } as any,
      {} as any,
    );
    expect(result.output).toContain(path);
    expect(readFileSync(path, "utf-8")).toBe("hello world");
  });

  test("overwrite existing file", async () => {
    const path = `${tmp.path}/overwrite.txt`;
    await writeFileTool.execute!({ path, content: "original" } as any, {} as any);
    await writeFileTool.execute!({ path, content: "replaced" } as any, {} as any);
    expect(readFileSync(path, "utf-8")).toBe("replaced");
  });

  test("write with createDirectories creates parent dirs", async () => {
    const path = `${tmp.path}/a/b/c/file.txt`;
    const result = await writeFileTool.execute!(
      { path, content: "nested", createDirectories: true } as any,
      {} as any,
    );
    expect(result.output).toContain(path);
    expect(readFileSync(path, "utf-8")).toBe("nested");
  });

  test("write error returns error object", async () => {
    const result = await writeFileTool.execute!(
      { path: "/dev/null/impossible", content: "fail" } as any,
      {} as any,
    );
    expect((result as any).error).toContain("Failed to write file:");
  });
});
