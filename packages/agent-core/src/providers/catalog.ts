import { z } from "zod";
import { getLogger } from "@logtape/logtape";
import { Env } from "../env.js";

const logger = getLogger(["molf", "providers", "catalog"]);

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000; // 60 minutes

// --- Zod schemas ---

const ModelsDevModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  reasoning: z.boolean().optional().default(false),
  tool_call: z.boolean().optional().default(false),
  temperature: z.boolean().optional().default(true),
  attachment: z.boolean().optional().default(false),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
  limit: z.object({
    context: z.number(),
    output: z.number(),
  }),
  modalities: z
    .object({
      input: z.array(
        z.enum(["text", "audio", "image", "video", "pdf"]),
      ),
      output: z.array(
        z.enum(["text", "audio", "image", "video", "pdf"]),
      ),
    })
    .optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  options: z.record(z.string(), z.any()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  provider: z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
    })
    .optional(),
  variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
});

const ModelsDevProvider = z.object({
  id: z.string(),
  name: z.string(),
  env: z.array(z.string()),
  npm: z.string().optional(),
  api: z.string().optional(),
  models: z.record(z.string(), ModelsDevModel),
});

export type ModelsDevModel = z.infer<typeof ModelsDevModel>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProvider>;

const CatalogSchema = z.record(z.string(), ModelsDevProvider);

// --- State ---
// Module-level singleton: shared across all server instances in the same process.
// Call resetCatalog() between test runs to clear cached data and stop the refresh timer.

let cachedData: Record<string, ModelsDevProvider> | undefined;
let lastFetchTime = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshStarted = false;

// --- Public API ---

export async function getCatalog(
  cacheDir?: string,
): Promise<Record<string, ModelsDevProvider>> {
  if (cachedData && Date.now() - lastFetchTime < REFRESH_INTERVAL_MS) {
    return cachedData;
  }

  if (Env.get("MODELS_DEV_DISABLE") === "1") {
    logger.debug`models.dev fetch disabled via MODELS_DEV_DISABLE`;
    return cachedData ?? {};
  }

  // Try disk cache first
  if (!cachedData && cacheDir) {
    cachedData = await readDiskCache(cacheDir);
    if (cachedData) {
      logger.debug`Loaded catalog from disk cache`;
      // Schedule live fetch in background
      refreshCatalog(cacheDir);
      startPeriodicRefresh(cacheDir);
      return cachedData;
    }
  }

  // Try bundled snapshot (available in compiled binaries)
  if (!cachedData) {
    const bundled = await readBundledSnapshot();
    if (bundled) {
      cachedData = bundled;
      logger.debug`Loaded catalog from bundled snapshot`;
      if (cacheDir) {
        refreshCatalog(cacheDir);
        startPeriodicRefresh(cacheDir);
      }
      return cachedData;
    }
  }

  // Live fetch
  try {
    const data = await fetchCatalog();
    cachedData = data;
    lastFetchTime = Date.now();
    if (cacheDir) await writeDiskCache(cacheDir, data);
    return data;
  } catch (err) {
    logger.warn`Failed to fetch models.dev catalog: ${err}`;
    return cachedData ?? {};
  }
}

export async function refreshCatalog(cacheDir: string): Promise<void> {
  try {
    const data = await fetchCatalog();
    cachedData = data;
    lastFetchTime = Date.now();
    await writeDiskCache(cacheDir, data);
    logger.debug`Catalog refreshed successfully`;
  } catch (err) {
    logger.warn`Failed to refresh catalog: ${err}`;
  }
}

/** Reset all state (for tests). */
export function resetCatalog(): void {
  cachedData = undefined;
  lastFetchTime = 0;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  refreshStarted = false;
}

// --- Internal ---

async function fetchCatalog(): Promise<Record<string, ModelsDevProvider>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const raw = await res.json();
    return CatalogSchema.parse(raw);
  } finally {
    clearTimeout(timeout);
  }
}

function startPeriodicRefresh(cacheDir: string): void {
  if (refreshStarted) return;
  refreshStarted = true;
  refreshTimer = setInterval(() => refreshCatalog(cacheDir), REFRESH_INTERVAL_MS);
  if (refreshTimer && typeof refreshTimer === "object" && "unref" in refreshTimer) {
    refreshTimer.unref();
  }
}

async function readBundledSnapshot(): Promise<
  Record<string, ModelsDevProvider> | undefined
> {
  try {
    // @ts-ignore — models-snapshot.ts is auto-generated by build.ts
    const { snapshot } = await import("./models-snapshot.js");
    return CatalogSchema.parse(snapshot);
  } catch {
    return undefined;
  }
}

async function readDiskCache(
  cacheDir: string,
): Promise<Record<string, ModelsDevProvider> | undefined> {
  try {
    const path = `${cacheDir}/models.json`;
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const raw = await file.json();
    return CatalogSchema.parse(raw);
  } catch (err) {
    logger.debug`Failed to read disk cache: ${err}`;
    return undefined;
  }
}

async function writeDiskCache(
  cacheDir: string,
  data: Record<string, ModelsDevProvider>,
): Promise<void> {
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cacheDir, { recursive: true });
    const path = `${cacheDir}/models.json`;
    await Bun.write(path, JSON.stringify(data));
  } catch (err) {
    logger.debug`Failed to write disk cache: ${err}`;
  }
}
