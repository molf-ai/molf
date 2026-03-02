import type { LanguageModel } from "ai";

export type CustomModelLoader = (
  sdk: any,
  modelID: string,
  options: Record<string, unknown>,
) => LanguageModel;

export interface CustomLoaderResult {
  /** Override how a LanguageModel is obtained from the SDK. */
  getModel?: CustomModelLoader;
  /** Extra options merged into the SDK factory call. */
  options?: Record<string, unknown>;
}

export const CUSTOM_LOADERS: Record<string, () => CustomLoaderResult> = {
  anthropic() {
    return {
      options: {
        headers: {
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      },
    };
  },

  openai() {
    return {
      getModel(sdk, modelID) {
        // Use responses API for GPT-5+, chat for older
        const match = /^gpt-(\d+)/.exec(modelID);
        if (match && Number(match[1]) >= 5) return sdk.responses(modelID);
        return sdk.chat(modelID);
      },
    };
  },
};
