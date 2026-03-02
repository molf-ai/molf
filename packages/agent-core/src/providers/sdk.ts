import type { LanguageModel } from "ai";
import type { ProviderV2 } from "@ai-sdk/provider";
import type { ProviderModel, ProviderState } from "./types.js";
import { BUNDLED_PROVIDERS } from "./bundled.js";

export function getSDK(
  state: ProviderState,
  model: ProviderModel,
): ProviderV2 {
  const provider = state.providers[model.providerID];
  const options: Record<string, unknown> = { ...provider.options };

  if (model.api.url) options.baseURL = model.api.url;
  if (!options.apiKey && provider.key) options.apiKey = provider.key;

  // Always merge — spreading empty headers is a no-op
  options.headers = { ...(options.headers as any), ...model.headers };

  // Cache by meaningful differentiators
  const baseURL = (options.baseURL as string) ?? "";
  const key = `${model.providerID}:${model.api.npm}:${baseURL}`;
  if (state.sdkCache.has(key)) return state.sdkCache.get(key)!;

  const factory = BUNDLED_PROVIDERS[model.api.npm];
  if (!factory) {
    throw new Error(
      `No bundled SDK for "${model.api.npm}". ` +
        `Provider "${model.providerID}" requires a package that isn't bundled.`,
    );
  }

  const sdk = factory({ name: model.providerID, ...options });
  state.sdkCache.set(key, sdk);
  return sdk;
}

export function getLanguageModel(
  state: ProviderState,
  model: ProviderModel,
): LanguageModel {
  const cacheKey = `${model.providerID}/${model.id}`;
  if (state.languageCache.has(cacheKey))
    return state.languageCache.get(cacheKey)!;

  const sdk = getSDK(state, model);
  const loader = state.modelLoaders[model.providerID];
  const language = loader
    ? loader(sdk, model.api.id, state.providers[model.providerID].options)
    : sdk.languageModel(model.api.id);

  state.languageCache.set(cacheKey, language);
  return language;
}
