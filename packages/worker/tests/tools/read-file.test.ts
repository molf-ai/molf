import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync } from "fs";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { readFileHandler } from "../../src/tools/read-file.js";
import type { ToolHandlerContext } from "@molf-ai/protocol";

let tmp: TmpDir;
const ctx: ToolHandlerContext = { toolCallId: "tc_test", workdir: "/tmp" };

beforeAll(() => {
  tmp = createTmpDir();
  tmp.writeFile("test.txt", "line1\nline2\nline3");
});
afterAll(() => tmp.cleanup());

describe("readFileHandler", () => {
  test("read existing file", async () => {
    const result = await readFileHandler(
      { path: `${tmp.path}/test.txt` },
      ctx,
    );
    expect(result.output).toContain("line1");
    expect(result.error).toBeUndefined();
  });

  test("read nonexistent file", async () => {
    const result = await readFileHandler(
      { path: `${tmp.path}/nope.txt` },
      ctx,
    );
    expect(result.error).toContain("not found");
    expect(result.output).toBe("");
  });

  test("read with startLine and endLine", async () => {
    const result = await readFileHandler(
      { path: `${tmp.path}/test.txt`, startLine: 2, endLine: 2 },
      ctx,
    );
    expect(result.output).toContain("line2");
    expect(result.output).not.toContain("line1");
    expect(result.output).not.toContain("line3");
  });

  test("truncate content exceeding MAX_CONTENT_LENGTH", async () => {
    const longContent = "x".repeat(200_000);
    tmp.writeFile("long.txt", longContent);
    const result = await readFileHandler(
      { path: `${tmp.path}/long.txt` },
      ctx,
    );
    expect(result.meta?.truncated).toBe(true);
    // Output includes "Content of <path> (<n> lines):\n" prefix + truncated content
    expect(result.output.length).toBeLessThan(200_000);
  });

  test("error on non-ENOENT failure", async () => {
    const noReadPath = `${tmp.path}/noread.txt`;
    tmp.writeFile("noread.txt", "secret");
    chmodSync(noReadPath, 0o000);
    try {
      const result = await readFileHandler(
        { path: noReadPath },
        ctx,
      );
      expect(result.error).toContain("Failed to read file:");
      expect(result.output).toBe("");
    } finally {
      chmodSync(noReadPath, 0o644);
    }
  });
});

describe("readFileHandler binary detection", () => {
  test("reads PNG as binary with attachment", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await Bun.write(`${tmp.path}/image.png`, png);

    const result = await readFileHandler(
      { path: `${tmp.path}/image.png` },
      ctx,
    );

    expect(result.output).toContain("image.png");
    expect(result.output).toContain("image/png");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("image/png");
    expect(result.attachments![0].size).toBe(4);
    expect(result.attachments![0].path).toBe(`${tmp.path}/image.png`);
    expect(typeof result.attachments![0].data).toBe("string"); // base64
  });

  test("reads JPEG as binary with attachment", async () => {
    await Bun.write(`${tmp.path}/photo.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
    const result = await readFileHandler(
      { path: `${tmp.path}/photo.jpg` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("image/jpeg");
  });

  test("reads PDF as binary with attachment", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    await Bun.write(`${tmp.path}/doc.pdf`, pdf);
    const result = await readFileHandler(
      { path: `${tmp.path}/doc.pdf` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("application/pdf");
  });

  test("reads audio file as binary with attachment", async () => {
    await Bun.write(`${tmp.path}/sound.mp3`, new Uint8Array([0xff, 0xfb]));
    const result = await readFileHandler(
      { path: `${tmp.path}/sound.mp3` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("audio/mpeg");
  });

  test("reads WebP as binary with attachment", async () => {
    await Bun.write(`${tmp.path}/sticker.webp`, new Uint8Array([1, 2, 3]));
    const result = await readFileHandler(
      { path: `${tmp.path}/sticker.webp` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("image/webp");
  });

  test("case-insensitive extension matching", async () => {
    await Bun.write(`${tmp.path}/IMAGE.PNG`, new Uint8Array([1]));
    const result = await readFileHandler(
      { path: `${tmp.path}/IMAGE.PNG` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].mimeType).toBe("image/png");
  });

  test("rejects binary file exceeding 15MB limit", async () => {
    const bigFile = new Uint8Array(16 * 1024 * 1024);
    await Bun.write(`${tmp.path}/huge.png`, bigFile);
    const result = await readFileHandler(
      { path: `${tmp.path}/huge.png` },
      ctx,
    );
    expect(result.error).toContain("too large");
    expect(result.output).toBe("");
  });

  test("returns base64-encoded data in attachment", async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    await Bun.write(`${tmp.path}/hello.png`, data);
    const result = await readFileHandler(
      { path: `${tmp.path}/hello.png` },
      ctx,
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].data).toBe(Buffer.from(data).toString("base64"));
  });

  test("non-binary extension reads as text", async () => {
    tmp.writeFile("code.ts", "const x = 1;");
    const result = await readFileHandler(
      { path: `${tmp.path}/code.ts` },
      ctx,
    );
    expect(result.output).toContain("const x = 1;");
    expect(result.attachments).toBeUndefined();
  });

  test("video extensions are not in binary list (read as text)", async () => {
    tmp.writeFile("video.mp4", "not-really-video");
    const result = await readFileHandler(
      { path: `${tmp.path}/video.mp4` },
      ctx,
    );
    // .mp4 is NOT in BINARY_EXTENSIONS — reads as text
    expect(result.output).toContain("not-really-video");
    expect(result.attachments).toBeUndefined();
  });
});

describe("readFileHandler opaque binary detection", () => {
  test(".zip extension returns error (fast-path)", async () => {
    await Bun.write(`${tmp.path}/archive.zip`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const result = await readFileHandler(
      { path: `${tmp.path}/archive.zip` },
      ctx,
    );
    expect(result.error).toContain("Cannot read binary file");
    expect(result.error).toContain(".zip");
  });

  test(".sqlite extension returns error (fast-path)", async () => {
    await Bun.write(`${tmp.path}/data.sqlite`, Buffer.from("SQLite format 3\0"));
    const result = await readFileHandler(
      { path: `${tmp.path}/data.sqlite` },
      ctx,
    );
    expect(result.error).toContain("Cannot read binary file");
    expect(result.error).toContain(".sqlite");
  });

  test("unknown extension with null bytes returns error (content detection)", async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await Bun.write(`${tmp.path}/mystery.xyz`, data);
    const result = await readFileHandler(
      { path: `${tmp.path}/mystery.xyz` },
      ctx,
    );
    expect(result.error).toContain("Cannot read binary file");
  });

  test("unknown extension with >30% non-printable returns error (content detection)", async () => {
    // 40% non-printable (control chars 1-8), 60% printable ASCII
    const data = new Uint8Array(100);
    for (let i = 0; i < 40; i++) data[i] = 1 + (i % 8); // non-printable (1-8)
    for (let i = 40; i < 100; i++) data[i] = 65 + (i % 26); // 'A'-'Z'
    await Bun.write(`${tmp.path}/weird.abc`, data);
    const result = await readFileHandler(
      { path: `${tmp.path}/weird.abc` },
      ctx,
    );
    expect(result.error).toContain("Cannot read binary file");
  });

  test("unknown extension with valid UTF-8 reads as text (no false positive)", async () => {
    await Bun.write(`${tmp.path}/readme.nfo`, "This is a perfectly valid text file.\nLine 2.");
    const result = await readFileHandler(
      { path: `${tmp.path}/readme.nfo` },
      ctx,
    );
    expect(result.output).toContain("perfectly valid text file");
    expect(result.error).toBeUndefined();
  });

  test("empty file with unknown extension reads as text (not binary)", async () => {
    await Bun.write(`${tmp.path}/empty.xyz`, new Uint8Array(0));
    const result = await readFileHandler(
      { path: `${tmp.path}/empty.xyz` },
      ctx,
    );
    expect(result.output).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});

describe("readFileHandler edge cases", () => {
  test("startLine past end of file returns empty content section", async () => {
    // File has 3 lines, request starts at line 100
    const result = await readFileHandler(
      { path: `${tmp.path}/test.txt`, startLine: 100 },
      ctx,
    );
    expect(result.error).toBeUndefined();
    // Output should have the header but no actual content lines
    expect(result.output).toContain("Content of");
    expect(result.output).not.toContain("line1");
    expect(result.output).not.toContain("line2");
    expect(result.output).not.toContain("line3");
  });

  test("endLine < startLine returns empty content section", async () => {
    const result = await readFileHandler(
      { path: `${tmp.path}/test.txt`, startLine: 3, endLine: 1 },
      ctx,
    );
    expect(result.error).toBeUndefined();
    // slice(2, 1) returns empty array
    expect(result.output).toContain("Content of");
    expect(result.output).not.toContain("line1");
    expect(result.output).not.toContain("line3");
  });

  test("file with Windows line endings (CRLF)", async () => {
    tmp.writeFile("crlf.txt", "line1\r\nline2\r\nline3\r\n");
    const result = await readFileHandler(
      { path: `${tmp.path}/crlf.txt` },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("line1");
    expect(result.output).toContain("line2");
    expect(result.output).toContain("line3");
  });

  test("startLine and endLine with Windows line endings", async () => {
    tmp.writeFile("crlf2.txt", "alpha\r\nbeta\r\ngamma\r\ndelta\r\n");
    const result = await readFileHandler(
      { path: `${tmp.path}/crlf2.txt`, startLine: 2, endLine: 3 },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("beta");
    expect(result.output).toContain("gamma");
    expect(result.output).not.toContain("alpha");
    expect(result.output).not.toContain("delta");
  });
});
