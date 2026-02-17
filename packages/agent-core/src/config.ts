import type { LLMConfig, BehaviorConfig } from "@molf-ai/protocol";

export type { LLMConfig, BehaviorConfig };

export interface AgentConfig {
  llm: LLMConfig;
  behavior: BehaviorConfig;
}

const DEFAULT_BEHAVIOR: BehaviorConfig = {
  maxSteps: 10,
};

export function createConfig(
  config?: Partial<{
    llm: Partial<LLMConfig>;
    behavior: Partial<BehaviorConfig>;
  }>,
): AgentConfig {
  if (!config?.llm?.provider || !config?.llm?.model) {
    throw new Error(
      "LLM provider and model are required. Set llm.provider and llm.model in config.",
    );
  }
  return {
    llm: { provider: config.llm.provider, model: config.llm.model, ...config.llm },
    behavior: { ...DEFAULT_BEHAVIOR, ...config?.behavior },
  };
}
