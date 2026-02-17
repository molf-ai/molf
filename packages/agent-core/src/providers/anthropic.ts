import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, ProviderModelConfig, LanguageModel } from "./types.js";

const ANTHROPIC_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
};

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly envKey = "ANTHROPIC_API_KEY";

  createModel(config: ProviderModelConfig): LanguageModel {
    const apiKey = config.apiKey ?? process.env[this.envKey];
    if (!apiKey) {
      throw new Error(
        `${this.envKey} is required. Set it in the environment or pass it in config.llm.apiKey.`,
      );
    }

    const anthropic = createAnthropic({ apiKey });
    return anthropic(config.model);
  }

  getContextWindow(model: string): number | undefined {
    return ANTHROPIC_CONTEXT_WINDOWS[model];
  }
}
