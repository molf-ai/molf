interface CacheEntry {
  buffer: Uint8Array;
  mimeType: string;
  savedAt: number;
}

const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_BYTES = 200 * 1024 * 1024; // 200MB total
const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * In-memory cache for image bytes to enable re-inlining on session resume.
 * Bounded: 8h TTL, 200MB max, FIFO eviction, periodic pruning.
 * On restart, cache is cold — files still on worker, accessible via read_file.
 */
export class InlineMediaCache {
  private cache = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private pruneTimer: Timer;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  save(path: string, buffer: Uint8Array, mimeType: string): void {
    this.delete(path); // remove existing if any

    // FIFO eviction if over budget
    while (this.totalBytes + buffer.byteLength > MAX_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value!;
      this.delete(oldestKey);
    }

    this.cache.set(path, { buffer, mimeType, savedAt: Date.now() });
    this.totalBytes += buffer.byteLength;
  }

  load(path: string): { buffer: Uint8Array; mimeType: string } | null {
    const entry = this.cache.get(path);
    if (!entry) return null;
    if (Date.now() - entry.savedAt > TTL_MS) {
      this.delete(path);
      return null;
    }
    return { buffer: entry.buffer, mimeType: entry.mimeType };
  }

  delete(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      this.totalBytes -= entry.buffer.byteLength;
      this.cache.delete(path);
    }
  }

  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.savedAt > TTL_MS) {
        this.delete(key);
        removed++;
      }
    }
    return removed;
  }

  close(): void {
    clearInterval(this.pruneTimer);
    this.cache.clear();
    this.totalBytes = 0;
  }
}
