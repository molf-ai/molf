export interface LLMConfig {
  provider: "gemini";
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
}

export interface BehaviorConfig {
  systemPrompt?: string;
  maxSteps: number;
}

export interface AgentConfig {
  llm: LLMConfig;
  behavior: BehaviorConfig;
}

const DEFAULT_LLM: LLMConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
};

const DEFAULT_BEHAVIOR: BehaviorConfig = {
  maxSteps: 10,
};

export function createConfig(
  overrides?: Partial<{
    llm: Partial<LLMConfig>;
    behavior: Partial<BehaviorConfig>;
  }>,
): AgentConfig {
  return {
    llm: { ...DEFAULT_LLM, ...overrides?.llm },
    behavior: { ...DEFAULT_BEHAVIOR, ...overrides?.behavior },
  };
}
