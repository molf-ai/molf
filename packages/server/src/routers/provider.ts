import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { loadJsonConfig, modifyConfigFile } from "../config.js";
import type { ProviderRegistryConfig } from "@molf-ai/agent-core";
import type { ServerContext } from "../context.js";
import type { ProviderSummary } from "../server-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function reloadProviders(context: ServerContext): Promise<void> {
  const json = loadJsonConfig(context.serverState.configPath);
  const storedKeys = context.providerKeyStore.getAll();
  const config: ProviderRegistryConfig = {
    model: context.serverState.defaultModel,
    enabled_providers: json.enabled_providers,
    custom_providers: json.custom_providers,
    storedKeys,
    dataDir: context.dataDir,
  };
  await context.serverState.reloadProviders(config);
}

function summarizeProviders(context: ServerContext): ProviderSummary[] {
  return Object.values(context.serverState.providerState.providers).map((p) => ({
    id: p.id,
    name: p.name,
    hasKey: !!p.key,
    keySource: p.key
      ? (p.source === "env" ? "env" as const : "stored" as const)
      : "none" as const,
    modelCount: Object.keys(p.models).length,
  }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const providerHandlers = {
  listProviders: os.provider.listProviders
    .use(authMiddleware)
    .handler(async ({ context }) => {
      // Return ALL known providers (catalog + custom), not just ones with keys.
      // This allows the TUI to show providers the user can add keys to.
      const activeProviders = context.serverState.providerState.providers;
      const storedKeys = context.providerKeyStore.getAll();
      const result = new Map<string, ProviderSummary>();

      // 1. Add all active providers (already have keys or are custom)
      for (const p of Object.values(activeProviders)) {
        result.set(p.id, {
          id: p.id,
          name: p.name,
          hasKey: !!p.key,
          keySource: p.key
            ? (p.source === "env" ? "env" as const : "stored" as const)
            : "none" as const,
          modelCount: Object.keys(p.models).length,
        });
      }

      // 2. Add catalog providers that aren't active (from lightweight catalogIndex).
      for (const entry of context.serverState.providerState.catalogIndex) {
        if (result.has(entry.id)) continue;
        const hasStoredKey = !!storedKeys[entry.id];
        result.set(entry.id, {
          id: entry.id,
          name: entry.name,
          hasKey: hasStoredKey,
          keySource: hasStoredKey ? "stored" : "none",
          modelCount: entry.modelCount,
        });
      }

      return { providers: [...result.values()] };
    }),

  listModels: os.provider.listModels
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const providers = context.serverState.providerState.providers;
      const provider = providers[input.providerID];

      const models: Array<{
        id: string;
        name: string;
        providerID: string;
        capabilities: { reasoning: boolean; toolcall: boolean; temperature: boolean };
        cost: { input: number; output: number };
        limit: { context: number; output: number };
        status: string;
      }> = [];

      if (provider) {
        for (const model of Object.values(provider.models)) {
          models.push({
            id: `${model.providerID}/${model.id}`,
            name: model.name,
            providerID: model.providerID,
            capabilities: {
              reasoning: model.capabilities.reasoning,
              toolcall: model.capabilities.toolcall,
              temperature: model.capabilities.temperature,
            },
            cost: { input: model.cost.input, output: model.cost.output },
            limit: { context: model.limit.context, output: model.limit.output },
            status: model.status,
          });
        }
      }

      return { models };
    }),

  setKey: os.provider.setKey
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      context.providerKeyStore.set(input.providerID, input.key);
      await reloadProviders(context);
      context.serverBus.emit({ type: "global" }, {
        type: "provider_state_changed",
        providers: summarizeProviders(context),
      });
      return { ok: true };
    }),

  removeKey: os.provider.removeKey
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      context.providerKeyStore.remove(input.providerID);
      await reloadProviders(context);
      context.serverBus.emit({ type: "global" }, {
        type: "provider_state_changed",
        providers: summarizeProviders(context),
      });
      return { ok: true };
    }),

  addCustomProvider: os.provider.addCustomProvider
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      // Validate ID doesn't collide with a catalog/env/config provider
      const existing = context.serverState.providerState.providers[input.id];
      if (existing && existing.source !== "custom") {
        throw new ORPCError("CONFLICT", {
          message: `Provider ID "${input.id}" conflicts with built-in provider "${existing.name}"`,
        });
      }

      // Build config entry for config.json
      const configEntry: Record<string, unknown> = {
        name: input.name,
        options: {
          baseURL: input.baseURL,
          ...(input.headers ? { headers: input.headers } : {}),
        },
        models: Object.fromEntries(
          input.models.map((m) => [
            m.id,
            {
              name: m.name,
              ...(m.limit ? { limit: m.limit } : {}),
            },
          ]),
        ),
      };
      if (input.npm) configEntry.npm = input.npm;

      modifyConfigFile(context.serverState.configPath, ["custom_providers", input.id], configEntry);

      // Store API key if provided
      if (input.apiKey) {
        context.providerKeyStore.set(input.id, input.apiKey);
      }

      await reloadProviders(context);

      context.serverBus.emit({ type: "global" }, {
        type: "config_changed",
        changedKeys: ["custom_providers"],
      });
      context.serverBus.emit({ type: "global" }, {
        type: "provider_state_changed",
        providers: summarizeProviders(context),
      });

      return { ok: true };
    }),

  updateCustomProvider: os.provider.updateCustomProvider
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const existing = context.serverState.providerState.providers[input.id];
      if (!existing || existing.source !== "custom") {
        throw new ORPCError("NOT_FOUND", {
          message: `Custom provider "${input.id}" not found`,
        });
      }

      // Read current config and merge updates
      const json = loadJsonConfig(context.serverState.configPath);
      const current = json.custom_providers?.[input.id] ?? {};
      const updated: Record<string, unknown> = { ...current };

      if (input.name !== undefined) updated.name = input.name;
      if (input.npm !== undefined) updated.npm = input.npm;
      if (input.baseURL !== undefined) {
        const opts = (updated.options as Record<string, unknown>) ?? {};
        opts.baseURL = input.baseURL;
        updated.options = opts;
      }
      if (input.headers !== undefined) {
        const opts = (updated.options as Record<string, unknown>) ?? {};
        opts.headers = input.headers;
        updated.options = opts;
      }
      if (input.models !== undefined) {
        updated.models = Object.fromEntries(
          input.models.map((m) => [
            m.id,
            {
              name: m.name,
              ...(m.limit ? { limit: m.limit } : {}),
            },
          ]),
        );
      }

      modifyConfigFile(context.serverState.configPath, ["custom_providers", input.id], updated);

      if (input.apiKey) {
        context.providerKeyStore.set(input.id, input.apiKey);
      }

      await reloadProviders(context);

      context.serverBus.emit({ type: "global" }, {
        type: "config_changed",
        changedKeys: ["custom_providers"],
      });
      context.serverBus.emit({ type: "global" }, {
        type: "provider_state_changed",
        providers: summarizeProviders(context),
      });

      return { ok: true };
    }),

  removeCustomProvider: os.provider.removeCustomProvider
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const existing = context.serverState.providerState.providers[input.id];
      if (!existing || existing.source !== "custom") {
        throw new ORPCError("NOT_FOUND", {
          message: `Custom provider "${input.id}" not found`,
        });
      }

      modifyConfigFile(context.serverState.configPath, ["custom_providers", input.id], undefined);
      context.providerKeyStore.remove(input.id);

      await reloadProviders(context);

      context.serverBus.emit({ type: "global" }, {
        type: "config_changed",
        changedKeys: ["custom_providers"],
      });
      context.serverBus.emit({ type: "global" }, {
        type: "provider_state_changed",
        providers: summarizeProviders(context),
      });

      return { ok: true };
    }),

  getCustomProvider: os.provider.getCustomProvider
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const provider = context.serverState.providerState.providers[input.id];
      if (!provider || provider.source !== "custom") {
        throw new ORPCError("NOT_FOUND", {
          message: `Custom provider "${input.id}" not found`,
        });
      }

      const json = loadJsonConfig(context.serverState.configPath);
      const config = json.custom_providers?.[input.id];

      const baseURL = (provider.options?.baseURL as string) ?? "";
      const headers = (provider.options?.headers as Record<string, string>) ?? undefined;

      return {
        id: provider.id,
        name: provider.name,
        npm: provider.npm,
        baseURL,
        ...(headers ? { headers } : {}),
        models: Object.values(provider.models).map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.limit ? { limit: { context: m.limit.context, output: m.limit.output } } : {}),
        })),
        hasKey: !!provider.key,
        keySource: (provider.key ? "stored" : "none") as "env" | "stored" | "none",
      };
    }),

  listCustomProviders: os.provider.listCustomProviders
    .use(authMiddleware)
    .handler(async ({ context }) => {
      const providers = context.serverState.providerState.providers;
      const customs = Object.values(providers)
        .filter((p) => p.source === "custom")
        .map((p) => ({
          id: p.id,
          name: p.name,
          npm: p.npm,
          baseURL: (p.options?.baseURL as string) ?? "",
          modelCount: Object.keys(p.models).length,
        }));

      return { providers: customs };
    }),
};
