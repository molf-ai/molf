import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileTool } from "../../src/tools/read-file.js";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const execute = readFileTool.execute! as (args: unknown) => Promise<any>;

let tempDir: string;
let testFilePath: string;
const testContent = "line one\nline two\nline three\nline four\nline five";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "read-file-test-"));
  testFilePath = join(tempDir, "test.txt");
  await writeFile(testFilePath, testContent, "utf-8");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("read_file tool", () => {
  test("has correct name and description", () => {
    expect(readFileTool.name).toBe("read_file");
    expect(readFileTool.description).toContain("Read the contents");
  });

  test("reads entire file", async () => {
    const result = await execute({ path: testFilePath });

    expect(result.content).toBe(testContent);
    expect(result.totalLines).toBe(5);
    expect(result.truncated).toBe(false);
  });

  test("reads specific line range", async () => {
    const result = await execute({
      path: testFilePath,
      startLine: 2,
      endLine: 4,
    });

    expect(result.content).toBe("line two\nline three\nline four");
    expect(result.totalLines).toBe(5);
  });

  test("reads from startLine to end of file", async () => {
    const result = await execute({
      path: testFilePath,
      startLine: 4,
    });

    expect(result.content).toBe("line four\nline five");
    expect(result.totalLines).toBe(5);
  });

  test("reads from beginning to endLine", async () => {
    const result = await execute({
      path: testFilePath,
      endLine: 2,
    });

    expect(result.content).toBe("line one\nline two");
    expect(result.totalLines).toBe(5);
  });

  test("returns error for nonexistent file", async () => {
    const result = await execute({ path: join(tempDir, "nope.txt") });

    expect(result.error).toContain("File not found");
  });

  test("reads empty file", async () => {
    const emptyPath = join(tempDir, "empty.txt");
    await writeFile(emptyPath, "", "utf-8");

    const result = await execute({ path: emptyPath });

    expect(result.content).toBe("");
    expect(result.totalLines).toBe(1); // split("") => [""]
    expect(result.truncated).toBe(false);
  });
});
