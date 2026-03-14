import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

// Mock snapshot to throw by default (simulates file not existing)
vi.mock("../src/providers/models-snapshot.js", () => {
  throw new Error("snapshot not available");
});

import { getCatalog, resetCatalog, type ModelsDevProvider } from "../src/providers/catalog.js";
import { Env } from "../src/env.js";

let tmp: TmpDir;
const originalFetch = globalThis.fetch;

function makeCatalog(overrides?: Partial<ModelsDevProvider>): Record<string, ModelsDevProvider> {
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
      models: {
        "claude-sonnet-4-20250514": {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          release_date: "2025-05-14",
          reasoning: false,
          tool_call: true,
          temperature: true,
          attachment: true,
          cost: { input: 3, output: 15 },
          limit: { context: 200000, output: 8192 },
        },
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  tmp = createTmpDir();
  resetCatalog();
  // Disable models.dev live fetch by default
  Env.set("MODELS_DEV_DISABLE", "1");
});

afterEach(() => {
  tmp.cleanup();
  globalThis.fetch = originalFetch;
  Env.reset();
  resetCatalog();
});

describe("getCatalog", () => {
  test("returns empty object when fetch is disabled and no cache", async () => {
    const result = await getCatalog(tmp.path);
    expect(result).toEqual({});
  });

  test("reads from disk cache when available", async () => {
    const catalog = makeCatalog();
    tmp.writeFile("models.json", JSON.stringify(catalog));

    // Remove disable flag to allow disk cache reading
    Env.delete_("MODELS_DEV_DISABLE");

    // Mock fetch to fail (so disk cache is the only source)
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as any;

    const result = await getCatalog(tmp.path);
    expect(result.anthropic).toBeDefined();
    expect(result.anthropic.id).toBe("anthropic");
    expect(result.anthropic.models["claude-sonnet-4-20250514"]).toBeDefined();
  });

  test("returns cached data on subsequent calls", async () => {
    const catalog = makeCatalog();
    tmp.writeFile("models.json", JSON.stringify(catalog));

    Env.delete_("MODELS_DEV_DISABLE");

    // Mock fetch to fail
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as any;

    const first = await getCatalog(tmp.path);
    const second = await getCatalog(tmp.path);
    expect(second).toBe(first); // same reference (cached)
  });

  test("gracefully falls back to empty on fetch failure with no cache", async () => {
    Env.delete_("MODELS_DEV_DISABLE");

    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as any;

    const result = await getCatalog();
    expect(result).toEqual({});
  });
});

describe("bundled snapshot fallback", () => {
  test("falls back to empty when snapshot is unavailable and no other source", async () => {
    // Snapshot is mocked to throw (see vi.mock at top), no disk cache, fetch fails
    Env.delete_("MODELS_DEV_DISABLE");
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as any;

    const result = await getCatalog();
    expect(result).toEqual({});
  });

  test("uses bundled snapshot when available and no disk cache", async () => {
    const catalog = makeCatalog();

    // Override the top-level mock to provide snapshot data
    vi.doMock("../src/providers/models-snapshot.js", () => ({
      snapshot: catalog,
    }));

    // Re-import to pick up the mock
    const { getCatalog: getCatalogFresh, resetCatalog: resetFresh } =
      await import("../src/providers/catalog.js");
    resetFresh();

    Env.delete_("MODELS_DEV_DISABLE");
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as any;

    const result = await getCatalogFresh();
    expect(result.anthropic).toBeDefined();
    expect(result.anthropic.id).toBe("anthropic");

    resetFresh();
    // Restore the throwing mock so subsequent tests don't see the real snapshot
    vi.doMock("../src/providers/models-snapshot.js", () => {
      throw new Error("snapshot not available");
    });
  });
});

describe("resetCatalog", () => {
  test("clears in-memory cache so next call re-fetches", async () => {
    const catalog = makeCatalog();
    tmp.writeFile("models.json", JSON.stringify(catalog));

    Env.delete_("MODELS_DEV_DISABLE");

    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network"))) as any;

    const first = await getCatalog(tmp.path);
    expect(first.anthropic).toBeDefined();

    resetCatalog();

    // After reset with no disk cache in a different dir, returns empty
    const result = await getCatalog();
    expect(result).toEqual({});
  });
});
