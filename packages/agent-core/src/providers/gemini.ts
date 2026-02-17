import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, ProviderModelConfig, LanguageModel } from "./types.js";

const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-2.5-pro-preview-05-06": 1_048_576,
  "gemini-2.5-flash-preview-04-17": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.0-flash-lite": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
};

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly envKey = "GEMINI_API_KEY";

  createModel(config: ProviderModelConfig): LanguageModel {
    const apiKey = config.apiKey ?? process.env[this.envKey];
    if (!apiKey) {
      throw new Error(
        `${this.envKey} is required. Set it in the environment or pass it in config.llm.apiKey.`,
      );
    }

    const google = createGoogleGenerativeAI({ apiKey });
    return google(config.model);
  }

  getContextWindow(model: string): number | undefined {
    return GEMINI_CONTEXT_WINDOWS[model];
  }
}
