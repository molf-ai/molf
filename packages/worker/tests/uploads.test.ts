import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { saveUploadedFile } from "../src/uploads.js";

let tmp: TmpDir;

beforeAll(() => {
  tmp = createTmpDir();
});

afterAll(() => tmp.cleanup());

describe("saveUploadedFile", () => {
  test("writes file to .molf/uploads/ directory", async () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff]);
    const result = await saveUploadedFile(tmp.path, data, "photo.jpg");

    expect(result.path).toMatch(/^\.molf\/uploads\//);
    expect(result.path).toContain("photo.jpg");
    expect(result.size).toBe(3);

    // Verify file was actually written
    const absPath = resolve(tmp.path, result.path);
    const file = Bun.file(absPath);
    expect(await file.exists()).toBe(true);
    const contents = new Uint8Array(await file.arrayBuffer());
    expect(contents).toEqual(data);
  });

  test("UUID-prefixes the filename", async () => {
    const result = await saveUploadedFile(tmp.path, new Uint8Array([1]), "test.txt");
    const filename = result.path.split("/").pop()!;
    // UUID is 36 chars + dash + filename
    expect(filename.length).toBeGreaterThan(36 + 1 + "test.txt".length - 1);
    expect(filename).toMatch(/^[0-9a-f-]{36}-test\.txt$/);
  });

  test("sanitizes special characters in filename", async () => {
    const result = await saveUploadedFile(tmp.path, new Uint8Array([1]), "my file (1).jpg");
    const filename = result.path.split("/").pop()!;
    expect(filename).not.toContain(" ");
    expect(filename).not.toContain("(");
    expect(filename).toContain("my_file__1_.jpg");
  });

  test("strips directory components from filename", async () => {
    const result = await saveUploadedFile(tmp.path, new Uint8Array([1]), "../../../etc/passwd");
    const filename = result.path.split("/").pop()!;
    // basename strips path, sanitization replaces remaining invalid chars
    expect(result.path).toMatch(/^\.molf\/uploads\//);
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("..");
  });

  test("creates uploads directory if it doesn't exist", async () => {
    const freshTmp = createTmpDir();
    try {
      const result = await saveUploadedFile(freshTmp.path, new Uint8Array([1]), "test.txt");
      // Verify directory was created and file exists
      const absPath = resolve(freshTmp.path, result.path);
      const file = Bun.file(absPath);
      expect(await file.exists()).toBe(true);
    } finally {
      freshTmp.cleanup();
    }
  });

  test("returns relative path starting with .molf/uploads/", async () => {
    const result = await saveUploadedFile(tmp.path, new Uint8Array([1]), "file.png");
    expect(result.path).toStartWith(".molf/uploads/");
  });

  test("reports correct byte size", async () => {
    const data = new Uint8Array(1024);
    const result = await saveUploadedFile(tmp.path, data, "big.bin");
    expect(result.size).toBe(1024);
  });
});
