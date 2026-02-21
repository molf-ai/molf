import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, ProviderModelConfig, LanguageModel } from "./types.js";

const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3-flash-preview": 1_000_000,
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
