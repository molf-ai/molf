import { describe, test, expect } from "vitest";
import {
  attachmentToContentParts,
  resolveFileRef,
  resolveSessionMessages,
  IMAGE_MIMES,
  MEDIA_HINT,
} from "../src/attachment-resolver.js";

// Minimal InlineMediaCache stub
function makeCache(entries: Record<string, Buffer> = {}) {
  return {
    load(path: string) {
      const buf = entries[path];
      return buf ? { buffer: buf } : null;
    },
  } as any;
}

describe("attachmentToContentParts", () => {
  test("image attachment returns text meta + image-data part", async () => {
    const att = {
      path: "/img.png",
      mimeType: "image/png",
      size: 100,
      data: new File([Buffer.from("base64data")], "img.png", { type: "image/png" }),
    };
    const parts = await attachmentToContentParts(att);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("image/png") });
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("/img.png") });
    expect(parts[1]).toMatchObject({ type: "image-data", mediaType: "image/png" });
    // data is base64-encoded from File contents
    expect(parts[1]).toHaveProperty("data");
  });

  test("non-image attachment returns text meta + file-data part", async () => {
    const att = {
      path: "/doc.pdf",
      mimeType: "application/pdf",
      size: 500,
      data: new File([Buffer.from("pdfdata")], "doc.pdf", { type: "application/pdf" }),
    };
    const parts = await attachmentToContentParts(att);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("application/pdf") });
    expect(parts[1]).toMatchObject({ type: "file-data", mediaType: "application/pdf" });
  });

  test("all IMAGE_MIMES produce image-data parts", async () => {
    for (const mime of IMAGE_MIMES) {
      const att = {
        path: "/file",
        mimeType: mime,
        size: 1,
        data: new File([Buffer.from("d")], "file", { type: mime }),
      };
      const parts = await attachmentToContentParts(att);
      expect(parts[1].type).toBe("image-data");
    }
  });

  test("meta text includes path, type, and size", async () => {
    const att = {
      path: "/a/b.jpg",
      mimeType: "image/jpeg",
      size: 42,
      data: new File([Buffer.from("x")], "b.jpg", { type: "image/jpeg" }),
    };
    const [meta] = await attachmentToContentParts(att);
    expect((meta as any).text).toBe("[Binary file: path: /a/b.jpg, type: image/jpeg, size: 42 bytes]");
  });
});

describe("resolveFileRef", () => {
  test("cached image returns inlined data", () => {
    const buf = Buffer.from("png-bytes");
    const cache = makeCache({ "/pic.png": buf });
    const result = resolveFileRef({ path: "/pic.png", mimeType: "image/png" }, cache);

    expect(result.inlined).toEqual({ data: buf, mimeType: "image/png" });
    expect(result.hint).toBeUndefined();
  });

  test("uncached image returns hint", () => {
    const cache = makeCache({});
    const result = resolveFileRef({ path: "/pic.png", mimeType: "image/png" }, cache);

    expect(result.inlined).toBeUndefined();
    expect(result.hint).toContain("/pic.png");
    expect(result.hint).toContain("read_file");
  });

  test("non-image always returns hint", () => {
    const buf = Buffer.from("data");
    const cache = makeCache({ "/doc.pdf": buf });
    const result = resolveFileRef({ path: "/doc.pdf", mimeType: "application/pdf" }, cache);

    expect(result.inlined).toBeUndefined();
    expect(result.hint).toContain("/doc.pdf");
  });
});

describe("resolveSessionMessages", () => {
  test("message without attachments passes through", () => {
    const msgs = [{
      id: "m1", role: "user" as const, content: "hello", timestamp: 1,
    }];
    const result = resolveSessionMessages(msgs, makeCache());

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
    expect(result[0].id).toBe("m1");
  });

  test("preserves optional fields (toolCalls, toolCallId, summary, etc.)", () => {
    const msgs = [{
      id: "m1", role: "tool" as const, content: "ok", timestamp: 1,
      toolCallId: "tc1", toolName: "echo", synthetic: true,
    }];
    const result = resolveSessionMessages(msgs, makeCache());

    expect(result[0].toolCallId).toBe("tc1");
    expect(result[0].toolName).toBe("echo");
    expect(result[0].synthetic).toBe(true);
  });

  test("message with cached image attachment inlines it", () => {
    const buf = Buffer.from("img");
    const cache = makeCache({ "/pic.png": buf });
    const msgs = [{
      id: "m1", role: "user" as const, content: "look at this", timestamp: 1,
      attachments: [{ path: "/pic.png", mimeType: "image/png" }],
    }];
    const result = resolveSessionMessages(msgs, cache);

    expect(result[0].attachments).toHaveLength(1);
    expect(result[0].attachments![0]).toEqual({ data: buf, mimeType: "image/png" });
  });

  test("message with non-image attachment prepends hint", () => {
    const msgs = [{
      id: "m1", role: "user" as const, content: "check this doc", timestamp: 1,
      attachments: [{ path: "/doc.pdf", mimeType: "application/pdf" }],
    }];
    const result = resolveSessionMessages(msgs, makeCache());

    expect(result[0].content).toContain("/doc.pdf");
    expect(result[0].content).toContain("check this doc");
    expect(result[0].attachments).toBeUndefined();
  });

  test("empty content with attachment hint becomes the hint", () => {
    const msgs = [{
      id: "m1", role: "user" as const, content: "", timestamp: 1,
      attachments: [{ path: "/f.txt", mimeType: "text/plain" }],
    }];
    const result = resolveSessionMessages(msgs, makeCache());

    expect(result[0].content).toContain("/f.txt");
    expect(result[0].content).not.toContain("\n\n");
  });

  test("multiple attachments produce multiple hints", () => {
    const msgs = [{
      id: "m1", role: "user" as const, content: "files", timestamp: 1,
      attachments: [
        { path: "/a.txt", mimeType: "text/plain" },
        { path: "/b.csv", mimeType: "text/csv" },
      ],
    }];
    const result = resolveSessionMessages(msgs, makeCache());

    expect(result[0].content).toContain("/a.txt");
    expect(result[0].content).toContain("/b.csv");
  });
});

describe("MEDIA_HINT", () => {
  test("is a non-empty string", () => {
    expect(typeof MEDIA_HINT).toBe("string");
    expect(MEDIA_HINT.length).toBeGreaterThan(0);
  });
});

describe("IMAGE_MIMES", () => {
  test("contains expected MIME types", () => {
    expect(IMAGE_MIMES.has("image/png")).toBe(true);
    expect(IMAGE_MIMES.has("image/jpeg")).toBe(true);
    expect(IMAGE_MIMES.has("image/gif")).toBe(true);
    expect(IMAGE_MIMES.has("image/webp")).toBe(true);
    expect(IMAGE_MIMES.has("image/svg+xml")).toBe(true);
  });

  test("does not contain non-image types", () => {
    expect(IMAGE_MIMES.has("application/pdf")).toBe(false);
    expect(IMAGE_MIMES.has("text/plain")).toBe(false);
  });
});
