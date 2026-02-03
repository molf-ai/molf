import type { streamText } from "ai";

/** The model type accepted by Vercel AI SDK's streamText */
export type LanguageModel = Parameters<typeof streamText>[0]["model"];

/** Minimal config passed to provider adapters */
export interface ProviderModelConfig {
  model: string;
  apiKey?: string;
}

/**
 * An LLM provider that can create model instances compatible with
 * Vercel AI SDK's streamText function.
 */
export interface LLMProvider {
  /** Human-readable name, e.g. "gemini", "anthropic" */
  readonly name: string;

  /** Environment variable name used as fallback for the API key */
  readonly envKey: string;

  /** Create a model instance for use with streamText() */
  createModel(config: ProviderModelConfig): LanguageModel;
}
