import type { BehaviorConfig } from "@molf-ai/protocol";

export type { BehaviorConfig };

export interface AgentConfig {
  behavior: BehaviorConfig;
}

const DEFAULT_BEHAVIOR: BehaviorConfig = {
  maxSteps: 10,
};

export function createConfig(
  config?: Partial<{
    behavior: Partial<BehaviorConfig>;
  }>,
): AgentConfig {
  return {
    behavior: { ...DEFAULT_BEHAVIOR, ...config?.behavior },
  };
}
