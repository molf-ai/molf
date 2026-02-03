import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, ProviderModelConfig, LanguageModel } from "./types.js";

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
}
