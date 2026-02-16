import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InlineMediaCache } from "../src/inline-media-cache.js";

let cache: InlineMediaCache;

beforeEach(() => {
  cache = new InlineMediaCache();
});

afterEach(() => {
  cache.close();
});

describe("InlineMediaCache", () => {
  describe("save and load", () => {
    test("stores and retrieves an entry", () => {
      const buf = new Uint8Array([1, 2, 3]);
      cache.save("a.jpg", buf, "image/jpeg");

      const loaded = cache.load("a.jpg");
      expect(loaded).not.toBeNull();
      expect(loaded!.buffer).toEqual(buf);
      expect(loaded!.mimeType).toBe("image/jpeg");
    });

    test("returns null for missing key", () => {
      expect(cache.load("nope")).toBeNull();
    });

    test("overwriting replaces old entry", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      cache.save("a.jpg", new Uint8Array([2, 3]), "image/png");

      const loaded = cache.load("a.jpg");
      expect(loaded!.buffer).toEqual(new Uint8Array([2, 3]));
      expect(loaded!.mimeType).toBe("image/png");
    });

    test("multiple distinct keys", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      cache.save("b.png", new Uint8Array([2]), "image/png");

      expect(cache.load("a.jpg")!.mimeType).toBe("image/jpeg");
      expect(cache.load("b.png")!.mimeType).toBe("image/png");
    });
  });

  describe("delete", () => {
    test("removes an existing entry", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      cache.delete("a.jpg");
      expect(cache.load("a.jpg")).toBeNull();
    });

    test("no-op for missing key", () => {
      cache.delete("nope"); // should not throw
    });
  });

  describe("TTL expiry", () => {
    test("expired entry returns null on load", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");

      // Manually expire: reach into private cache and set savedAt to 9h ago
      const entry = (cache as any).cache.get("a.jpg");
      entry.savedAt = Date.now() - 9 * 60 * 60 * 1000;

      expect(cache.load("a.jpg")).toBeNull();
    });

    test("fresh entry is returned", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      expect(cache.load("a.jpg")).not.toBeNull();
    });
  });

  describe("FIFO eviction", () => {
    test("evicts oldest entries when over budget", () => {
      // MAX_BYTES = 200MB. Create entries that force eviction.
      const big = new Uint8Array(100 * 1024 * 1024); // 100MB
      cache.save("a.jpg", big, "image/jpeg");
      cache.save("b.jpg", big, "image/png");

      // Both fit (200MB total). Adding another 100MB should evict a.jpg.
      cache.save("c.jpg", big, "image/webp");

      expect(cache.load("a.jpg")).toBeNull(); // evicted
      expect(cache.load("b.jpg")).not.toBeNull();
      expect(cache.load("c.jpg")).not.toBeNull();
    });

    test("evicts multiple entries if needed", () => {
      const chunk = new Uint8Array(80 * 1024 * 1024); // 80MB each
      cache.save("a.jpg", chunk, "image/jpeg");
      cache.save("b.jpg", chunk, "image/png");

      // 160MB used. Adding another 80MB → 240MB > 200MB → must evict a.jpg (80MB).
      // After eviction of a: 80+80=160 ≤ 200. OK.
      cache.save("c.jpg", chunk, "image/webp");

      expect(cache.load("a.jpg")).toBeNull();
      expect(cache.load("b.jpg")).not.toBeNull();
      expect(cache.load("c.jpg")).not.toBeNull();
    });
  });

  describe("prune", () => {
    test("removes expired entries and returns count", () => {
      cache.save("fresh.jpg", new Uint8Array([1]), "image/jpeg");
      cache.save("old.jpg", new Uint8Array([2]), "image/png");

      // Expire old.jpg
      (cache as any).cache.get("old.jpg").savedAt = Date.now() - 9 * 60 * 60 * 1000;

      const removed = cache.prune();
      expect(removed).toBe(1);
      expect(cache.load("old.jpg")).toBeNull();
      expect(cache.load("fresh.jpg")).not.toBeNull();
    });

    test("returns 0 when nothing to prune", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      expect(cache.prune()).toBe(0);
    });

    test("returns 0 on empty cache", () => {
      expect(cache.prune()).toBe(0);
    });
  });

  describe("close", () => {
    test("clears all entries", () => {
      cache.save("a.jpg", new Uint8Array([1]), "image/jpeg");
      cache.close();

      expect(cache.load("a.jpg")).toBeNull();
      expect((cache as any).totalBytes).toBe(0);
    });
  });

  describe("totalBytes tracking", () => {
    test("tracks bytes across save/delete", () => {
      cache.save("a.jpg", new Uint8Array(100), "image/jpeg");
      expect((cache as any).totalBytes).toBe(100);

      cache.save("b.jpg", new Uint8Array(200), "image/png");
      expect((cache as any).totalBytes).toBe(300);

      cache.delete("a.jpg");
      expect((cache as any).totalBytes).toBe(200);

      cache.delete("b.jpg");
      expect((cache as any).totalBytes).toBe(0);
    });

    test("overwrite adjusts bytes correctly", () => {
      cache.save("a.jpg", new Uint8Array(100), "image/jpeg");
      cache.save("a.jpg", new Uint8Array(50), "image/jpeg");
      expect((cache as any).totalBytes).toBe(50);
    });
  });
});
