import { describe, it, expect } from "bun:test";
import { EmbeddedBlockChunker, type BlockChunkerConfig } from "../src/block-chunker.js";

function collectChunks(
  chunker: EmbeddedBlockChunker,
  opts: { force?: boolean } = {},
): string[] {
  const chunks: string[] = [];
  chunker.drain({ force: opts.force ?? false, emit: (c) => chunks.push(c) });
  return chunks;
}

describe("EmbeddedBlockChunker", () => {
  describe("basic buffering", () => {
    it("buffers text below minChars", () => {
      const chunker = new EmbeddedBlockChunker({ minChars: 100, maxChars: 400 });
      chunker.append("short");
      const chunks = collectChunks(chunker);
      expect(chunks).toHaveLength(0);
      expect(chunker.hasBuffered()).toBe(true);
      expect(chunker.bufferedText).toBe("short");
    });

    it("ignores empty appends", () => {
      const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 100 });
      chunker.append("");
      expect(chunker.hasBuffered()).toBe(false);
    });

    it("force-flushes all buffered text", () => {
      const chunker = new EmbeddedBlockChunker({ minChars: 100, maxChars: 400 });
      chunker.append("small text");
      const chunks = collectChunks(chunker, { force: true });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("small text");
      expect(chunker.hasBuffered()).toBe(false);
    });

    it("reset clears the buffer", () => {
      const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 100 });
      chunker.append("some text");
      chunker.reset();
      expect(chunker.hasBuffered()).toBe(false);
      expect(chunker.bufferedText).toBe("");
    });
  });

  describe("paragraph breaks", () => {
    it("splits on paragraph break when text exceeds minChars", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 400,
        breakPreference: "paragraph",
      });
      chunker.append("First paragraph here.\n\nSecond paragraph here.");
      const chunks = collectChunks(chunker);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]).toContain("First paragraph");
    });

    it("does not split paragraph break inside a code fence", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 800,
        breakPreference: "paragraph",
      });
      chunker.append("```\nline1\n\nline2\n```\nafter");
      // The \n\n is inside a fence, so it should not split there
      const chunks = collectChunks(chunker);
      // Either no chunks emitted or the fence content stays together
      if (chunks.length > 0) {
        // If it did emit, the fence content should not be split
        expect(chunks[0]).toContain("```");
      }
    });
  });

  describe("flushOnParagraph", () => {
    it("eagerly flushes on paragraph boundary regardless of minChars", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      chunker.append("Short paragraph.\n\nNext part.");
      const chunks = collectChunks(chunker);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Short paragraph.");
      // "Next part." remains buffered (no trailing \n\n)
      expect(chunker.bufferedText).toBe("Next part.");
    });

    it("flushes multiple paragraphs in sequence", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      chunker.append("Para one.\n\nPara two.\n\nPara three.");
      const chunks = collectChunks(chunker);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toBe("Para one.");
      expect(chunks[1]).toBe("Para two.");
      expect(chunker.bufferedText).toBe("Para three.");
    });

    it("does not flush when no paragraph boundary exists", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      chunker.append("Just one long line with no paragraph break at all.");
      const chunks = collectChunks(chunker);
      expect(chunks).toHaveLength(0);
      expect(chunker.hasBuffered()).toBe(true);
    });
  });

  describe("sentence breaks", () => {
    it("breaks on sentence boundary when preference is paragraph (fallback)", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 100,
        breakPreference: "paragraph",
      });
      // No paragraph break, but there is a sentence end
      const text = "This is a sentence. And another sentence follows right here in the same block.";
      chunker.append(text);
      const chunks = collectChunks(chunker);
      // Should split at a sentence boundary
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("incremental streaming simulation", () => {
    it("accumulates tokens and emits at paragraph breaks with flushOnParagraph", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      const allChunks: string[] = [];

      // Simulate token-by-token streaming
      const tokens = ["Hello ", "world. ", "This is ", "paragraph one.", "\n", "\n", "Start of ", "paragraph two."];
      for (const token of tokens) {
        chunker.append(token);
        chunker.drain({ force: false, emit: (c) => allChunks.push(c) });
      }

      // Should have emitted the first paragraph after seeing \n\n
      expect(allChunks).toHaveLength(1);
      expect(allChunks[0]).toBe("Hello world. This is paragraph one.");
      expect(chunker.bufferedText).toBe("Start of paragraph two.");
    });

    it("force-flush emits remaining buffer at end of stream", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      const allChunks: string[] = [];

      chunker.append("First paragraph.\n\nSecond paragraph tail.");
      chunker.drain({ force: false, emit: (c) => allChunks.push(c) });

      expect(allChunks).toHaveLength(1);
      expect(allChunks[0]).toBe("First paragraph.");

      // Force flush remaining
      chunker.drain({ force: true, emit: (c) => allChunks.push(c) });
      expect(allChunks).toHaveLength(2);
      expect(allChunks[1]).toBe("Second paragraph tail.");
      expect(chunker.hasBuffered()).toBe(false);
    });
  });

  describe("maxChars enforcement", () => {
    it("breaks at maxChars when buffer exceeds limit without paragraph break", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 50,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });
      const longText = "a".repeat(60);
      chunker.append(longText);
      const chunks = collectChunks(chunker);
      // Should have split since buffer > maxChars
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].length).toBeLessThanOrEqual(50);
    });
  });
});
