import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { editFileHandler } from "../../src/tools/edit-file.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { join } from "path";
import type { ToolHandlerContext } from "@molf-ai/protocol";

const ctx: ToolHandlerContext = { toolCallId: "tc_edit", workdir: "/tmp" };

describe("editFileHandler", () => {
  let tmp: TmpDir;

  beforeEach(() => {
    tmp = createTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  test("replace single occurrence", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = await editFileHandler(
      { path: filePath, oldString: "hello", newString: "goodbye" },
      ctx,
    );
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    expect(result.error).toBeUndefined();
    const content = await Bun.file(filePath).text();
    expect(content).toBe("goodbye world");
  });

  test("error on not found", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = await editFileHandler(
      { path: filePath, oldString: "missing", newString: "found" },
      ctx,
    );
    expect(result.error).toContain("not found in file");
  });

  test("error on multiple matches without replaceAll", async () => {
    const filePath = tmp.writeFile("test.txt", "aaa bbb aaa ccc aaa");
    const result = await editFileHandler(
      { path: filePath, oldString: "aaa", newString: "xxx" },
      ctx,
    );
    expect(result.error).toContain("3 times");
    expect(result.error).toContain("replaceAll");
  });

  test("replaceAll works", async () => {
    const filePath = tmp.writeFile("test.txt", "aaa bbb aaa ccc aaa");
    const result = await editFileHandler(
      { path: filePath, oldString: "aaa", newString: "xxx", replaceAll: true },
      ctx,
    );
    expect(result.output).toContain("Replaced 3 occurrence(s)");
    expect(result.error).toBeUndefined();
    const content = await Bun.file(filePath).text();
    expect(content).toBe("xxx bbb xxx ccc xxx");
  });

  test("error on identical strings", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = await editFileHandler(
      { path: filePath, oldString: "hello", newString: "hello" },
      ctx,
    );
    expect(result.error).toContain("identical");
  });

  test("error on empty oldString", async () => {
    const filePath = tmp.writeFile("test.txt", "hello world");
    const result = await editFileHandler(
      { path: filePath, oldString: "", newString: "something" },
      ctx,
    );
    expect(result.error).toContain("must not be empty");
  });

  test("error on missing file", async () => {
    const filePath = join(tmp.path, "nonexistent.txt");
    const result = await editFileHandler(
      { path: filePath, oldString: "hello", newString: "goodbye" },
      ctx,
    );
    expect(result.error).toContain("File not found");
  });

  test("special characters in oldString are literal-matched", async () => {
    const filePath = tmp.writeFile("test.txt", "value = foo.bar(baz);\n");
    const result = await editFileHandler(
      { path: filePath, oldString: "foo.bar(baz)", newString: "qux()" },
      ctx,
    );
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("value = qux();\n");
  });

  test("replacement resulting in empty file", async () => {
    const filePath = tmp.writeFile("empty-result.txt", "delete me");
    const result = await editFileHandler(
      { path: filePath, oldString: "delete me", newString: "" },
      ctx,
    );
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    expect(result.error).toBeUndefined();
    const content = await Bun.file(filePath).text();
    expect(content).toBe("");
  });

  test("replacement across line boundaries", async () => {
    const filePath = tmp.writeFile("multiline.txt", "line1\nline2\nline3\n");
    const result = await editFileHandler(
      { path: filePath, oldString: "line1\nline2", newString: "combined" },
      ctx,
    );
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    expect(result.error).toBeUndefined();
    const content = await Bun.file(filePath).text();
    expect(content).toBe("combined\nline3\n");
  });

  test("multiple occurrences without replaceAll returns count in error", async () => {
    const filePath = tmp.writeFile("dupes.txt", "foo bar foo");
    const result = await editFileHandler(
      { path: filePath, oldString: "foo", newString: "baz" },
      ctx,
    );
    expect(result.error).toContain("2 times");
    expect(result.error).toContain("replaceAll");
    // File should be unchanged
    const content = await Bun.file(filePath).text();
    expect(content).toBe("foo bar foo");
  });
});
