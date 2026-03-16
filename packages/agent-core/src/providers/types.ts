import type { LanguageModel } from "ai";
import type { ProviderV2 } from "@ai-sdk/provider";
import type { CustomModelLoader } from "./custom-loaders.js";

/** A resolved model with full metadata, ready for SDK instantiation. */
export interface ProviderModel {
  id: string;
  providerID: string;
  name: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  capabilities: {
    reasoning: boolean;
    toolcall: boolean;
    temperature: boolean;
    input: {
      text: boolean;
      image: boolean;
      pdf: boolean;
      audio: boolean;
      video: boolean;
    };
    output: {
      text: boolean;
      image: boolean;
      pdf: boolean;
      audio: boolean;
      video: boolean;
    };
  };
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  limit: {
    context: number;
    output: number;
  };
  status: "active" | "alpha" | "beta" | "deprecated";
  headers: Record<string, string>;
  options: Record<string, unknown>;
}

/** A resolved provider with its available models. */
export interface ProviderInfo {
  id: string;
  name: string;
  env: string[];
  npm: string;
  source: "env" | "config" | "custom" | "catalog";
  key?: string;
  options: Record<string, unknown>;
  models: Record<string, ProviderModel>;
}

/**
 * A resolved model bundled with its SDK LanguageModel instance.
 * Used throughout the agent/server layer for both SDK calls and metadata access.
 */
export interface ResolvedModel {
  language: LanguageModel;
  info: ProviderModel;
}

/** Lightweight metadata for a catalog provider (no model details). */
export interface CatalogProviderEntry {
  id: string;
  name: string;
  npm: string;
  env: string[];
  modelCount: number;
}

/** Runtime state for the provider system. Created by initProviders(). */
export interface ProviderState {
  providers: Record<string, ProviderInfo>;
  /** All catalog providers with bundled SDK support (pre-filter, lightweight). */
  catalogIndex: CatalogProviderEntry[];
  sdkCache: Map<string, ProviderV2>;
  languageCache: Map<string, LanguageModel>;
  modelLoaders: Record<string, CustomModelLoader>;
}
