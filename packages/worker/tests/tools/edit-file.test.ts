import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { editFileTool } from "../../src/tools/edit-file.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { join } from "path";

describe("editFileTool", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = createTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  test("replace single occurrence", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "hello", newString: "goodbye" } as any,
      {} as any,
    )) as any;
    expect(result.replacements).toBe(1);
    expect(result.path).toBe(filePath);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("goodbye world");
  });

  test("error on not found", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "missing", newString: "found" } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("not found in file");
  });

  test("error on multiple matches without replaceAll", async () => {
    const filePath = tmp.writeFile("test.txt", "aaa bbb aaa ccc aaa");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "aaa", newString: "xxx" } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("3 times");
    expect(result.error).toContain("replaceAll");
  });

  test("replaceAll works", async () => {
    const filePath = tmp.writeFile("test.txt", "aaa bbb aaa ccc aaa");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "aaa", newString: "xxx", replaceAll: true } as any,
      {} as any,
    )) as any;
    expect(result.replacements).toBe(3);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("xxx bbb xxx ccc xxx");
  });

  test("error on identical strings", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "hello", newString: "hello" } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("identical");
  });

  test("error on empty oldString", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "", newString: "something" } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("must not be empty");
  });

  test("error on missing file", async () => {
    const filePath = join(tmp.path, "nonexistent.txt");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "hello", newString: "goodbye" } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("File not found");
  });

  test("special characters in oldString are literal-matched", async () => {
    const filePath = tmp.writeFile("test.txt", "value = foo.bar(baz);\n");
    const result = (await editFileTool.execute!(
      { path: filePath, oldString: "foo.bar(baz)", newString: "qux()" } as any,
      {} as any,
    )) as any;
    expect(result.replacements).toBe(1);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("value = qux();\n");
  });
});
