import { getLogger } from "@logtape/logtape";
import type {
  PluginDescriptor,
  HookRegistry,
  WorkerSkillInfo,
  WorkerAgentInfo,
} from "@molf-ai/protocol";
import type { ToolExecutor } from "./tool-executor.js";
import { WorkerPluginApiImpl, type SyncStateFn } from "./plugin-api.js";

const logger = getLogger(["molf", "worker", "plugin"]);

interface PluginConfig {
  specifier: string;
  config?: unknown;
}

interface LoadedPlugin {
  name: string;
  api: WorkerPluginApiImpl;
  destroy?: () => void | Promise<void>;
}

/**
 * Loads and manages worker-side plugins. The server sends a list of plugin
 * specifiers on connect; this class imports each, calls descriptor.worker(api),
 * and tracks return values for cleanup.
 */
export class WorkerPluginLoader {
  private loaded: LoadedPlugin[] = [];
  private syncStateFn: SyncStateFn | null = null;

  constructor(
    private readonly hookRegistry: HookRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly skills: WorkerSkillInfo[],
    private readonly agents: WorkerAgentInfo[],
    private readonly workdir: string,
  ) {}

  /**
   * Load plugins from a list of specifiers with optional per-plugin config.
   * Errors in one plugin are logged and do not prevent others from loading.
   */
  async loadPlugins(plugins: PluginConfig[]): Promise<void> {
    for (const plugin of plugins) {
      try {
        await this.loadOne(plugin);
      } catch (err) {
        logger.error("Failed to load plugin", {
          specifier: plugin.specifier,
          error: err,
        });
      }
    }
  }

  private async loadOne(plugin: PluginConfig): Promise<void> {
    logger.debug("Loading plugin", { specifier: plugin.specifier });

    const mod = await import(plugin.specifier);
    const descriptor: PluginDescriptor = mod.default ?? mod;

    if (this.loaded.some(p => p.name === descriptor.name)) {
      logger.error("Duplicate plugin name, skipping", { plugin: descriptor.name });
      return;
    }

    if (!descriptor.worker) {
      logger.debug("Plugin has no worker() function, skipping", {
        specifier: plugin.specifier,
      });
      return;
    }

    // Validate config if schema is provided
    let config = plugin.config;
    if (descriptor.configSchema && config !== undefined) {
      const result = descriptor.configSchema.safeParse(config);
      if (!result.success) {
        logger.error("Plugin config validation failed", {
          plugin: descriptor.name,
          error: result.error,
        });
        return;
      }
      config = result.data;
    }

    const api = new WorkerPluginApiImpl(
      descriptor.name,
      this.hookRegistry,
      this.toolExecutor,
      this.skills,
      this.agents,
      this.workdir,
      config,
    );

    if (this.syncStateFn) {
      api.setSyncStateFn(this.syncStateFn);
    }

    const cleanup = await descriptor.worker(api);
    const destroy = cleanup && typeof cleanup === "object" && "destroy" in cleanup
      ? cleanup.destroy
      : undefined;

    this.loaded.push({ name: descriptor.name, api, destroy });
    logger.info("Plugin loaded", { plugin: descriptor.name });
  }

  /** Destroy all loaded plugins in reverse order. Called on shutdown or disconnect. */
  async destroyAll(): Promise<void> {
    for (let i = this.loaded.length - 1; i >= 0; i--) {
      const plugin = this.loaded[i];
      if (plugin.destroy) {
        try {
          await plugin.destroy();
        } catch (err) {
          logger.error("Error destroying plugin", {
            plugin: plugin.name,
            error: err,
          });
        }
      }
      this.hookRegistry.removePlugin(plugin.name);
    }
    this.loaded = [];
  }

  /** Wire syncState into all loaded (and future) plugin APIs. */
  setSyncStateFn(fn: SyncStateFn): void {
    this.syncStateFn = fn;
    for (const plugin of this.loaded) {
      plugin.api.setSyncStateFn(fn);
    }
  }

  getLoadedPluginNames(): string[] {
    return this.loaded.map((p) => p.name);
  }
}
