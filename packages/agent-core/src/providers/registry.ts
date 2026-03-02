import type { LanguageModel } from "ai";
import { getLogger } from "@logtape/logtape";
import { Env } from "../env.js";
import { parseModelId } from "./model-id.js";
import type { ProviderModel, ProviderInfo, ProviderState } from "./types.js";
import { getCatalog, type ModelsDevProvider, type ModelsDevModel } from "./catalog.js";
import { CUSTOM_LOADERS } from "./custom-loaders.js";
import { getLanguageModel as getLanguageModelFromSDK } from "./sdk.js";

const logger = getLogger(["molf", "providers", "registry"]);

/** Config shape expected by the registry (subset of server config). */
export interface ProviderRegistryConfig {
  model: string;
  enabled_providers?: string[];
  enable_all_providers?: boolean;
  providers?: Record<
    string,
    {
      env?: string[];
      npm?: string;
      api?: string;
      options?: Record<string, unknown>;
      models?: Record<
        string,
        {
          name?: string;
          limit?: { context?: number; output?: number };
          options?: Record<string, unknown>;
        }
      >;
    }
  >;
  dataDir?: string;
}

// --- Public API ---

export async function initProviders(
  config: ProviderRegistryConfig,
): Promise<ProviderState> {
  const state: ProviderState = {
    providers: {},
    sdkCache: new Map(),
    languageCache: new Map(),
    modelLoaders: {},
  };

  // 1. Load catalog
  const cacheDir = config.dataDir ? `${config.dataDir}/cache` : undefined;
  const catalog = await getCatalog(cacheDir);
  logger.debug`Loaded ${Object.keys(catalog).length} providers from catalog`;

  // 2. Transform catalog providers → ProviderInfo
  for (const [providerID, catalogProvider] of Object.entries(catalog)) {
    state.providers[providerID] = fromCatalogProvider(
      providerID,
      catalogProvider,
    );
  }

  // 3. Determine allowed providers
  const allowed = buildAllowedProviders(config);

  // 4. Env detection — only for allowed providers
  const env = Env.all();
  for (const [providerID, provider] of Object.entries(state.providers)) {
    if (allowed !== "all" && !allowed.has(providerID)) continue;
    const apiKey = provider.env.map((k) => env[k]).find(Boolean);
    if (apiKey) {
      provider.source = "env";
      provider.key = apiKey;
    }
  }

  // 5. Config providers — merge overrides and custom providers
  if (config.providers) {
    for (const [providerID, configProvider] of Object.entries(
      config.providers,
    )) {
      const existing = state.providers[providerID];
      if (existing) {
        // Merge options into existing provider
        if (configProvider.options) {
          existing.options = { ...existing.options, ...configProvider.options };
        }
        if (configProvider.models) {
          for (const [modelID, modelConfig] of Object.entries(
            configProvider.models,
          )) {
            if (existing.models[modelID]) {
              if (modelConfig.name)
                existing.models[modelID].name = modelConfig.name;
              if (modelConfig.limit) {
                if (modelConfig.limit.context !== undefined)
                  existing.models[modelID].limit.context =
                    modelConfig.limit.context;
                if (modelConfig.limit.output !== undefined)
                  existing.models[modelID].limit.output =
                    modelConfig.limit.output;
              }
            } else {
              existing.models[modelID] = createCustomModel(
                providerID,
                modelID,
                modelConfig,
                existing,
              );
            }
          }
        }
        if (!existing.key) {
          const envKeys = configProvider.env ?? existing.env;
          const apiKey = envKeys.map((k) => env[k]).find(Boolean);
          if (apiKey) {
            existing.key = apiKey;
            existing.source = "config";
          }
        }
      } else {
        // Create new custom provider
        const envKeys = configProvider.env ?? [];
        const apiKey = envKeys.map((k) => env[k]).find(Boolean);
        const info: ProviderInfo = {
          id: providerID,
          name: providerID,
          env: envKeys,
          npm: configProvider.npm ?? "@ai-sdk/openai-compatible",
          source: "custom",
          key: apiKey,
          options: configProvider.options ?? {},
          models: {},
        };
        if (configProvider.models) {
          for (const [modelID, modelConfig] of Object.entries(
            configProvider.models,
          )) {
            info.models[modelID] = createCustomModel(
              providerID,
              modelID,
              modelConfig,
              info,
            );
          }
        }
        state.providers[providerID] = info;
      }
    }
  }

  // 6. Apply CUSTOM_LOADERS
  for (const [providerID, loaderFn] of Object.entries(CUSTOM_LOADERS)) {
    const provider = state.providers[providerID];
    if (!provider || !provider.key) continue;

    const result = loaderFn();
    if (result.options) {
      provider.options = { ...provider.options, ...result.options };
    }
    if (result.getModel) {
      state.modelLoaders[providerID] = result.getModel;
    }
  }

  // 7. Filter — remove non-allowed, keyless, deprecated, empty
  for (const [providerID, provider] of Object.entries(state.providers)) {
    if (allowed !== "all" && !allowed.has(providerID)) {
      delete state.providers[providerID];
      continue;
    }
    if (!provider.key && provider.source !== "custom") {
      delete state.providers[providerID];
      continue;
    }
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (model.status === "deprecated") {
        delete provider.models[modelID];
      }
    }
    if (Object.keys(provider.models).length === 0) {
      delete state.providers[providerID];
    }
  }

  const modelCount = Object.values(state.providers).reduce(
    (sum, p) => sum + Object.keys(p.models).length,
    0,
  );
  logger.info`Initialized ${Object.keys(state.providers).length} providers with ${modelCount} models`;

  return state;
}

export function resolveLanguageModel(
  state: ProviderState,
  model: ProviderModel,
): LanguageModel {
  return getLanguageModelFromSDK(state, model);
}

export function getModel(
  state: ProviderState,
  providerID: string,
  modelID: string,
): ProviderModel {
  const provider = state.providers[providerID];
  if (!provider) {
    const available = Object.keys(state.providers).join(", ");
    throw new Error(
      `Unknown provider "${providerID}". Available: ${available || "(none)"}`,
    );
  }
  const model = provider.models[modelID];
  if (!model) {
    const available = Object.keys(provider.models).join(", ");
    throw new Error(
      `Unknown model "${modelID}" for provider "${providerID}". Available: ${available || "(none)"}`,
    );
  }
  return model;
}

export function listProviders(state: ProviderState): ProviderInfo[] {
  return Object.values(state.providers);
}

export function listModels(
  state: ProviderState,
  providerID?: string,
): ProviderModel[] {
  if (providerID) {
    const provider = state.providers[providerID];
    return provider ? Object.values(provider.models) : [];
  }
  return Object.values(state.providers).flatMap((p) =>
    Object.values(p.models),
  );
}

// --- Internal helpers ---

function buildAllowedProviders(
  config: ProviderRegistryConfig,
): Set<string> | "all" {
  if (config.enable_all_providers) return "all";

  const allowed = new Set<string>();
  const defaultRef = parseModelId(config.model);
  allowed.add(defaultRef.providerID);

  if (config.enabled_providers) {
    for (const id of config.enabled_providers) allowed.add(id);
  }
  if (config.providers) {
    for (const id of Object.keys(config.providers)) allowed.add(id);
  }

  return allowed;
}

function fromCatalogProvider(
  providerID: string,
  catalog: ModelsDevProvider,
): ProviderInfo {
  const models: Record<string, ProviderModel> = {};
  for (const [modelID, catalogModel] of Object.entries(catalog.models)) {
    models[modelID] = fromCatalogModel(
      providerID,
      modelID,
      catalogModel,
      catalog,
    );
  }
  return {
    id: providerID,
    name: catalog.name,
    env: catalog.env,
    npm: catalog.npm ?? "@ai-sdk/openai-compatible",
    source: "catalog",
    options: {},
    models,
  };
}

function fromCatalogModel(
  providerID: string,
  modelID: string,
  model: ModelsDevModel,
  provider: ModelsDevProvider,
): ProviderModel {
  const inputMods = model.modalities?.input ?? ["text"];
  const outputMods = model.modalities?.output ?? ["text"];

  return {
    id: modelID,
    providerID,
    name: model.name,
    api: {
      id: modelID,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    capabilities: {
      reasoning: model.reasoning,
      toolcall: model.tool_call,
      temperature: model.temperature,
      input: {
        text: inputMods.includes("text"),
        image: inputMods.includes("image"),
        pdf: inputMods.includes("pdf"),
        audio: inputMods.includes("audio"),
        video: inputMods.includes("video"),
      },
      output: {
        text: outputMods.includes("text"),
        image: outputMods.includes("image"),
        pdf: outputMods.includes("pdf"),
        audio: outputMods.includes("audio"),
        video: outputMods.includes("video"),
      },
    },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache: {
        read: model.cost?.cache_read ?? 0,
        write: model.cost?.cache_write ?? 0,
      },
    },
    limit: {
      context: model.limit.context,
      output: model.limit.output,
    },
    status: model.status ?? "active",
    headers: model.headers ?? {},
    options: model.options ?? {},
  };
}

function createCustomModel(
  providerID: string,
  modelID: string,
  config: {
    name?: string;
    limit?: { context?: number; output?: number };
    options?: Record<string, unknown>;
  },
  provider: ProviderInfo,
): ProviderModel {
  return {
    id: modelID,
    providerID,
    name: config.name ?? modelID,
    api: {
      id: modelID,
      url: (provider.options.baseURL as string) ?? "",
      npm: provider.npm,
    },
    capabilities: {
      reasoning: false,
      toolcall: true,
      temperature: true,
      input: {
        text: true,
        image: false,
        pdf: false,
        audio: false,
        video: false,
      },
      output: {
        text: true,
        image: false,
        pdf: false,
        audio: false,
        video: false,
      },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: config.limit?.context ?? 0,
      output: config.limit?.output ?? 0,
    },
    status: "active",
    headers: {},
    options: config.options ?? {},
  };
}
