import { getLogger } from "@logtape/logtape";
import { HookRegistry } from "@molf-ai/protocol";
import type { PluginDescriptor, PluginCleanup } from "@molf-ai/protocol";
import {
  createServerPluginApi,
  type PluginService,
  type PluginRouteEntry,
  type PluginToolEntry,
  type SessionToolFactory,
  type ServerPluginInternals,
} from "./plugin-api.js";

const logger = getLogger(["molf", "server", "plugin-loader"]);

export interface PluginConfigEntry {
  /** Module specifier or path */
  name: string;
  config?: unknown;
}

interface LoadedPlugin {
  descriptor: PluginDescriptor;
  destroy?: () => void | Promise<void>;
}

export class PluginLoader {
  readonly hookRegistry = new HookRegistry();
  readonly pluginTools: PluginToolEntry[] = [];
  readonly pluginRoutes: PluginRouteEntry[] = [];
  readonly pluginServices: PluginService[] = [];
  readonly sessionToolFactories: SessionToolFactory[] = [];
  /** Names of plugins that have a worker() function — sent to workers on connect. */
  readonly workerPluginSpecifiers: string[] = [];

  private loadedPlugins: LoadedPlugin[] = [];
  private pluginNames: string[] = [];

  /** Logger adapter for HookRegistry dispatch calls. */
  readonly hookLogger = {
    warn: (msg: string, props?: Record<string, unknown>) => logger.warn(msg, props),
  };

  /**
   * Load and initialize all plugins from config.
   * Errors in individual plugins are caught and logged — they don't prevent other plugins from loading.
   */
  async loadAll(
    pluginConfigs: PluginConfigEntry[],
    internals: ServerPluginInternals,
  ): Promise<void> {
    for (const entry of pluginConfigs) {
      try {
        await this.loadOne(entry, internals);
      } catch (err) {
        logger.error(`Failed to load plugin "${entry.name}": ${err instanceof Error ? err.message : String(err)}`, {
          plugin: entry.name,
          error: err,
        });
      }
    }
  }

  private async loadOne(
    entry: PluginConfigEntry,
    internals: ServerPluginInternals,
  ): Promise<void> {
    const specifier = resolveSpecifier(entry.name);
    const mod = await import(specifier);
    const descriptor: PluginDescriptor = mod.default ?? mod;

    if (!descriptor.name || typeof descriptor.name !== "string") {
      throw new Error(`Plugin at "${entry.name}" has no valid name`);
    }

    if (this.pluginNames.includes(descriptor.name)) {
      throw new Error(`Duplicate plugin name: "${descriptor.name}"`);
    }

    // Validate config if schema provided
    let validatedConfig = entry.config;
    if (descriptor.configSchema && entry.config !== undefined) {
      const result = descriptor.configSchema.safeParse(entry.config);
      if (!result.success) {
        throw new Error(`Config validation failed for plugin "${descriptor.name}": ${result.error}`);
      }
      validatedConfig = result.data;
    }

    // Track worker specifier if plugin has worker()
    if (descriptor.worker) {
      this.workerPluginSpecifiers.push(entry.name);
    }

    // Only call server() if present
    if (!descriptor.server) {
      this.loadedPlugins.push({ descriptor });
      this.pluginNames.push(descriptor.name);
      logger.info(`Loaded plugin "${descriptor.name}" (worker-only)`);
      return;
    }

    const api = createServerPluginApi(
      descriptor.name,
      validatedConfig,
      this.hookRegistry,
      internals,
      this.pluginTools,
      this.pluginRoutes,
      this.pluginServices,
      this.sessionToolFactories,
    );

    const cleanup: PluginCleanup = await Promise.resolve(descriptor.server(api));
    const destroy = cleanup && typeof cleanup === "object" && "destroy" in cleanup
      ? cleanup.destroy
      : undefined;

    this.loadedPlugins.push({ descriptor, destroy });
    this.pluginNames.push(descriptor.name);
    logger.info(`Loaded plugin "${descriptor.name}"`);
  }

  /** Start all registered services (called after all plugins are initialized). */
  async startServices(): Promise<void> {
    for (const service of this.pluginServices) {
      try {
        await service.start();
      } catch (err) {
        logger.error(`Plugin service failed to start: ${err instanceof Error ? err.message : String(err)}`, { error: err });
      }
    }
  }

  /** Stop services (reverse order) and call plugin destroy() functions. */
  async shutdown(): Promise<void> {
    // Stop services in reverse order
    for (let i = this.pluginServices.length - 1; i >= 0; i--) {
      try {
        await this.pluginServices[i].stop();
      } catch (err) {
        logger.error(`Plugin service failed to stop: ${err instanceof Error ? err.message : String(err)}`, { error: err });
      }
    }

    // Call destroy on plugins in reverse order
    for (let i = this.loadedPlugins.length - 1; i >= 0; i--) {
      const plugin = this.loadedPlugins[i];
      if (plugin.destroy) {
        try {
          await plugin.destroy();
        } catch (err) {
          logger.error(`Plugin "${plugin.descriptor.name}" destroy failed: ${err instanceof Error ? err.message : String(err)}`, { error: err });
        }
      }
      this.hookRegistry.removePlugin(plugin.descriptor.name);
    }
  }

  /** Get list of active plugins for plugin.list query. */
  getPluginList(): Array<{ name: string; routes: string[]; tools: string[] }> {
    return this.pluginNames.map((name) => ({
      name,
      routes: this.pluginRoutes
        .filter((r) => r.pluginName === name)
        .flatMap((r) => Object.keys(r.routes)),
      tools: this.pluginTools
        .filter((t) => t.pluginName === name)
        .map((t) => t.name),
    }));
  }
}

/**
 * Resolve a plugin specifier to an importable path.
 * All specifiers (local paths, scoped packages, npm packages) resolve via import().
 */
function resolveSpecifier(name: string): string {
  return name;
}
