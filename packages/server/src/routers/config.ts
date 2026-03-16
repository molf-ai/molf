import { os, authMiddleware } from "../context.js";
import { loadJsonConfig, modifyConfigFile } from "../config.js";
import { ORPCError } from "@orpc/server";

// Keys that can be applied at runtime without restart
const HOT_RELOAD_KEYS = new Set(["model", "enabled_providers", "custom_providers", "behavior", "plugins"]);
// Keys that require restart
const RESTART_KEYS = new Set(["host", "port", "tls", "tlsCert", "tlsKey", "dataDir", "noTls"]);

export const configHandlers = {
  get: os.config.get
    .use(authMiddleware)
    .handler(async ({ context }) => {
      const json = loadJsonConfig(context.serverState.configPath);
      return {
        model: context.serverState.defaultModel || undefined,
        host: json.host ?? "127.0.0.1",
        port: json.port ?? 7600,
        custom_providers: json.custom_providers,
        enabled_providers: json.enabled_providers,
        behavior: json.behavior,
        plugins: json.plugins?.map(p => ({ name: p.name })),
      };
    }),

  set: os.config.set
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const rootKey = input.path[0];

      // Reject unknown keys
      if (!HOT_RELOAD_KEYS.has(rootKey) && !RESTART_KEYS.has(rootKey)) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Unknown config key: "${rootKey}"`,
        });
      }

      const requiresRestart = RESTART_KEYS.has(rootKey);

      // Write to config.json
      modifyConfigFile(context.serverState.configPath, input.path, input.value);

      // Apply at runtime if possible
      if (!requiresRestart) {
        if (rootKey === "model") {
          context.serverState.defaultModel = input.value as string | undefined;
        } else if (rootKey === "behavior") {
          const json = loadJsonConfig(context.serverState.configPath);
          context.serverState.behavior = json.behavior ?? {};
        }

        if (rootKey === "model" || rootKey === "enabled_providers" || rootKey === "custom_providers") {
          // Reload providers
          const json = loadJsonConfig(context.serverState.configPath);
          const storedKeys = context.providerKeyStore.getAll();
          await context.serverState.reloadProviders({
            model: context.serverState.defaultModel,
            enabled_providers: json.enabled_providers,
            custom_providers: json.custom_providers,
            storedKeys,
            dataDir: context.dataDir,
          });
        }

        // Broadcast config_changed event
        context.serverBus.emit({ type: "global" }, {
          type: "config_changed",
          changedKeys: [rootKey],
        });

        // If providers were affected, also broadcast provider_state_changed
        if (rootKey === "model" || rootKey === "enabled_providers" || rootKey === "custom_providers") {
          context.serverBus.emit({ type: "global" }, {
            type: "provider_state_changed",
            providers: Object.values(context.serverState.providerState.providers).map((p) => ({
              id: p.id,
              name: p.name,
              hasKey: !!p.key,
              keySource: p.key ? (p.source === "env" ? "env" as const : "stored" as const) : "none" as const,
              modelCount: Object.keys(p.models).length,
            })),
          });
        }
      }

      return { ok: true, requiresRestart };
    }),
};
