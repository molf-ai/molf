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

describe("readFileTool binary detection", () => {
  test("reads PNG as BinaryResult", async () => {
    // Minimal PNG header
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await Bun.write(`${tmp.path}/image.png`, png);

    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/image.png` } as any,
      {} as any,
    )) as any;

    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("image/png");
    expect(result.size).toBe(4);
    expect(result.path).toBe(`${tmp.path}/image.png`);
    expect(typeof result.data).toBe("string"); // base64
  });

  test("reads JPEG as binary", async () => {
    await Bun.write(`${tmp.path}/photo.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/photo.jpg` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("reads PDF as binary", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    await Bun.write(`${tmp.path}/doc.pdf`, pdf);
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/doc.pdf` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("application/pdf");
  });

  test("reads audio file as binary", async () => {
    await Bun.write(`${tmp.path}/sound.mp3`, new Uint8Array([0xff, 0xfb]));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/sound.mp3` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("audio/mpeg");
  });

  test("reads WebP as binary", async () => {
    await Bun.write(`${tmp.path}/sticker.webp`, new Uint8Array([1, 2, 3]));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/sticker.webp` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("image/webp");
  });

  test("case-insensitive extension matching", async () => {
    await Bun.write(`${tmp.path}/IMAGE.PNG`, new Uint8Array([1]));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/IMAGE.PNG` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.mimeType).toBe("image/png");
  });

  test("rejects binary file exceeding 15MB limit", async () => {
    const bigFile = new Uint8Array(16 * 1024 * 1024);
    await Bun.write(`${tmp.path}/huge.png`, bigFile);
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/huge.png` } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("too large");
  });

  test("returns base64-encoded data", async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    await Bun.write(`${tmp.path}/hello.png`, data);
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/hello.png` } as any,
      {} as any,
    )) as any;
    expect(result.type).toBe("binary");
    expect(result.data).toBe(Buffer.from(data).toString("base64"));
  });

  test("non-binary extension reads as text", async () => {
    tmp.writeFile("code.ts", "const x = 1;");
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/code.ts` } as any,
      {} as any,
    )) as any;
    expect(result.content).toBe("const x = 1;");
    expect(result.type).toBeUndefined();
  });

  test("video extensions are not in binary list (read as text)", async () => {
    tmp.writeFile("video.mp4", "not-really-video");
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/video.mp4` } as any,
      {} as any,
    )) as any;
    // .mp4 is NOT in BINARY_EXTENSIONS — reads as text
    expect(result.content).toBeDefined();
    expect(result.type).toBeUndefined();
  });
});

describe("readFileTool opaque binary detection", () => {
  test(".zip extension returns error (fast-path)", async () => {
    await Bun.write(`${tmp.path}/archive.zip`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/archive.zip` } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("Cannot read binary file");
    expect(result.error).toContain(".zip");
  });

  test(".sqlite extension returns error (fast-path)", async () => {
    await Bun.write(`${tmp.path}/data.sqlite`, Buffer.from("SQLite format 3\0"));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/data.sqlite` } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("Cannot read binary file");
    expect(result.error).toContain(".sqlite");
  });

  test("unknown extension with null bytes returns error (content detection)", async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await Bun.write(`${tmp.path}/mystery.xyz`, data);
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/mystery.xyz` } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("Cannot read binary file");
  });

  test("unknown extension with >30% non-printable returns error (content detection)", async () => {
    // 40% non-printable (control chars 1-8), 60% printable ASCII
    const data = new Uint8Array(100);
    for (let i = 0; i < 40; i++) data[i] = 1 + (i % 8); // non-printable (1-8)
    for (let i = 40; i < 100; i++) data[i] = 65 + (i % 26); // 'A'-'Z'
    await Bun.write(`${tmp.path}/weird.abc`, data);
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/weird.abc` } as any,
      {} as any,
    )) as any;
    expect(result.error).toContain("Cannot read binary file");
  });

  test("unknown extension with valid UTF-8 reads as text (no false positive)", async () => {
    await Bun.write(`${tmp.path}/readme.nfo`, "This is a perfectly valid text file.\nLine 2.");
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/readme.nfo` } as any,
      {} as any,
    )) as any;
    expect(result.content).toContain("perfectly valid text file");
    expect(result.error).toBeUndefined();
  });

  test("empty file with unknown extension reads as text (not binary)", async () => {
    await Bun.write(`${tmp.path}/empty.xyz`, new Uint8Array(0));
    const result = (await readFileTool.execute!(
      { path: `${tmp.path}/empty.xyz` } as any,
      {} as any,
    )) as any;
    expect(result.content).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});
