export type { LLMProvider, ProviderModelConfig, LanguageModel } from "./types.js";
export { ProviderRegistry } from "./registry.js";
export { GeminiProvider } from "./gemini.js";
export { AnthropicProvider } from "./anthropic.js";

import { ProviderRegistry } from "./registry.js";
import { GeminiProvider } from "./gemini.js";
import { AnthropicProvider } from "./anthropic.js";

/**
 * Create a ProviderRegistry pre-loaded with the built-in
 * Vercel AI SDK adapters (Gemini + Anthropic).
 */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("gemini", new GeminiProvider());
  registry.register("anthropic", new AnthropicProvider());
  return registry;
}
