import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileTool } from "../../src/tools/write-file.js";
import { readFileTool } from "../../src/tools/read-file.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const writeExec = writeFileTool.execute! as (args: unknown) => Promise<any>;
const readExec = readFileTool.execute! as (args: unknown) => Promise<any>;

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "write-file-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("write_file tool", () => {
  test("has correct name and description", () => {
    expect(writeFileTool.name).toBe("write_file");
    expect(writeFileTool.description).toContain("Write content");
  });

  test("creates and writes a new file", async () => {
    const filePath = join(tempDir, "new.txt");
    const result = await writeExec({
      path: filePath,
      content: "hello world",
    });

    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(11);

    // Verify via read
    const read = await readExec({ path: filePath });
    expect(read.content).toBe("hello world");
  });

  test("overwrites existing file", async () => {
    const filePath = join(tempDir, "overwrite.txt");

    await writeExec({ path: filePath, content: "first" });
    await writeExec({ path: filePath, content: "second" });

    const read = await readExec({ path: filePath });
    expect(read.content).toBe("second");
  });

  test("creates parent directories when requested", async () => {
    const filePath = join(tempDir, "a", "b", "c", "deep.txt");
    const result = await writeExec({
      path: filePath,
      content: "deep content",
      createDirectories: true,
    });

    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBeGreaterThan(0);

    const read = await readExec({ path: filePath });
    expect(read.content).toBe("deep content");
  });

  test("writes to nested path even without createDirectories (Bun.write creates dirs)", async () => {
    const filePath = join(tempDir, "x", "y", "z", "auto.txt");
    const result = await writeExec({
      path: filePath,
      content: "auto-created dirs",
    });

    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBeGreaterThan(0);

    const read = await readExec({ path: filePath });
    expect(read.content).toBe("auto-created dirs");
  });

  test("writes multiline content", async () => {
    const filePath = join(tempDir, "multiline.txt");
    const content = "line 1\nline 2\nline 3\n";
    const result = await writeExec({ path: filePath, content });

    expect(result.bytesWritten).toBe(content.length);

    const read = await readExec({ path: filePath });
    expect(read.content).toBe(content);
  });
});
