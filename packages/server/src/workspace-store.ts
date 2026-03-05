import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getLogger } from "@logtape/logtape";
import type { Workspace, WorkspaceConfig } from "@molf-ai/protocol";

const log = getLogger(["molf", "workspace-store"]);

export class WorkspaceStore {
  /** In-memory cache: Map<workerId, Map<workspaceId, Workspace>> */
  private cache = new Map<string, Map<string, Workspace>>();
  /** In-flight loadAll promises to prevent concurrent disk reads for the same worker. */
  private loading = new Map<string, Promise<Map<string, Workspace>>>();

  constructor(private dataDir: string) {}

  /** Path: data/workers/{workerId}/workspaces */
  private workspacesDir(workerId: string): string {
    return join(this.dataDir, "workers", workerId, "workspaces");
  }

  private workspacePath(workerId: string, workspaceId: string): string {
    return join(this.workspacesDir(workerId), workspaceId, "state.json");
  }

  /** Load all workspaces for a worker from disk (lazy, cached). */
  private async loadAll(workerId: string): Promise<Map<string, Workspace>> {
    if (this.cache.has(workerId)) return this.cache.get(workerId)!;

    // Deduplicate concurrent loads for the same worker
    const inflight = this.loading.get(workerId);
    if (inflight) return inflight;

    const loadPromise = this.loadFromDisk(workerId);
    this.loading.set(workerId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.loading.delete(workerId);
    }
  }

  private async loadFromDisk(workerId: string): Promise<Map<string, Workspace>> {
    const map = new Map<string, Workspace>();
    const dir = this.workspacesDir(workerId);

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const raw = await readFile(join(dir, entry.name, "state.json"), "utf-8");
          const ws: Workspace = JSON.parse(raw);
          map.set(ws.id, ws);
        } catch (e) {
          log.warn`Failed to load workspace ${entry.name} for worker ${workerId}: ${e}`;
        }
      }
    } catch {
      // No workspaces dir yet — that's fine
    }

    this.cache.set(workerId, map);
    return map;
  }

  /** Atomic write: write tmp + rename. */
  private async save(workerId: string, workspaceId: string): Promise<void> {
    const map = this.cache.get(workerId);
    const ws = map?.get(workspaceId);
    if (!ws) return;

    const dir = join(this.workspacesDir(workerId), workspaceId);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, "state.json");
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(ws, null, 2));
    await rename(tmpPath, filePath);
  }

  async get(workerId: string, workspaceId: string): Promise<Workspace | undefined> {
    const map = await this.loadAll(workerId);
    return map.get(workspaceId);
  }

  async getByName(workerId: string, name: string): Promise<Workspace | undefined> {
    const map = await this.loadAll(workerId);
    for (const ws of map.values()) {
      if (ws.name === name) return ws;
    }
    return undefined;
  }

  async getDefault(workerId: string): Promise<Workspace | undefined> {
    const map = await this.loadAll(workerId);
    for (const ws of map.values()) {
      if (ws.isDefault) return ws;
    }
    return undefined;
  }

  async list(workerId: string): Promise<Workspace[]> {
    const map = await this.loadAll(workerId);
    return Array.from(map.values());
  }

  async create(workerId: string, name: string, config?: WorkspaceConfig): Promise<Workspace> {
    const map = await this.loadAll(workerId);

    // Check name uniqueness
    for (const ws of map.values()) {
      if (ws.name === name) {
        throw new Error(`Workspace name "${name}" already exists for worker ${workerId}`);
      }
    }

    const ws: Workspace = {
      id: randomUUID(),
      name,
      isDefault: false,
      lastSessionId: "",   // will be set when first session is added
      sessions: [],
      createdAt: Date.now(),
      config: config ?? {},
    };

    map.set(ws.id, ws);
    await this.save(workerId, ws.id);
    return ws;
  }

  async rename(workerId: string, workspaceId: string, newName: string): Promise<boolean> {
    const map = await this.loadAll(workerId);
    const ws = map.get(workspaceId);
    if (!ws) return false;

    // Check name uniqueness
    for (const other of map.values()) {
      if (other.id !== workspaceId && other.name === newName) {
        throw new Error(`Workspace name "${newName}" already exists for worker ${workerId}`);
      }
    }

    ws.name = newName;
    await this.save(workerId, ws.id);
    return true;
  }

  async addSession(workerId: string, workspaceId: string, sessionId: string): Promise<void> {
    const map = await this.loadAll(workerId);
    const ws = map.get(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

    if (!ws.sessions.includes(sessionId)) {
      ws.sessions.push(sessionId);
    }
    ws.lastSessionId = sessionId;
    await this.save(workerId, ws.id);
  }

  async updateLastSession(workerId: string, workspaceId: string, sessionId: string): Promise<void> {
    const map = await this.loadAll(workerId);
    const ws = map.get(workspaceId);
    if (!ws || ws.lastSessionId === sessionId) return;

    ws.lastSessionId = sessionId;
    await this.save(workerId, ws.id);
  }

  async setConfig(workerId: string, workspaceId: string, config: WorkspaceConfig): Promise<void> {
    const map = await this.loadAll(workerId);
    const ws = map.get(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

    ws.config = config;
    await this.save(workerId, ws.id);
  }

  async ensureDefault(workerId: string): Promise<Workspace> {
    const existing = await this.getDefault(workerId);
    if (existing) return existing;

    const map = await this.loadAll(workerId);
    const ws: Workspace = {
      id: randomUUID(),
      name: "main",
      isDefault: true,
      lastSessionId: "",
      sessions: [],
      createdAt: Date.now(),
      config: {},
    };

    map.set(ws.id, ws);
    await this.save(workerId, ws.id);
    return ws;
  }
}
