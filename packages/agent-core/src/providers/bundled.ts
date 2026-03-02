import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// Each SDK factory has its own typed options and return type.
// We erase to a common shape since we pass options dynamically.
// The ProviderV2 contract is enforced at call sites (getSDK → sdk.languageModel).
export const BUNDLED_PROVIDERS: Record<
  string,
  (options: Record<string, any>) => any
> = {
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/google": createGoogleGenerativeAI,
  "@ai-sdk/openai": createOpenAI,
  "@ai-sdk/openai-compatible": (opts: Record<string, any>) =>
    createOpenAICompatible(opts as any),
  "@ai-sdk/xai": createXai,
  "@ai-sdk/mistral": createMistral,
  "@ai-sdk/groq": createGroq,
  "@ai-sdk/deepinfra": createDeepInfra,
  "@ai-sdk/cerebras": createCerebras,
  "@ai-sdk/cohere": createCohere,
  "@ai-sdk/togetherai": createTogetherAI,
  "@ai-sdk/perplexity": createPerplexity,
  "@ai-sdk/amazon-bedrock": createAmazonBedrock,
  "@ai-sdk/google-vertex": createVertex,
  "@ai-sdk/azure": createAzure,
  "@openrouter/ai-sdk-provider": createOpenRouter,
};
