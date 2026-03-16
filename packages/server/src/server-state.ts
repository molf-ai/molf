import type { ProviderState, ProviderRegistryConfig } from "@molf-ai/agent-core";
import { initProviders } from "@molf-ai/agent-core";

export class ServerState {
  providerState: ProviderState;
  defaultModel: string | undefined;
  behavior: { temperature?: number; contextPruning?: boolean };
  configPath: string;

  constructor(opts: {
    providerState: ProviderState;
    defaultModel: string | undefined;
    behavior?: { temperature?: number; contextPruning?: boolean };
    configPath: string;
  }) {
    this.providerState = opts.providerState;
    this.defaultModel = opts.defaultModel;
    this.behavior = opts.behavior ?? {};
    this.configPath = opts.configPath;
  }

  /** Re-initialize providers from current config + stored keys + env vars. */
  async reloadProviders(config: ProviderRegistryConfig): Promise<void> {
    this.providerState = await initProviders(config);
  }
}
