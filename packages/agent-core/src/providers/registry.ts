import type { LLMProvider } from "./types.js";

/**
 * Registry of LLM providers keyed by name.
 * Comes pre-loaded with built-in Vercel AI SDK adapters;
 * callers can register additional (or replacement) providers at runtime.
 */
export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /** Register a provider under the given name (overwrites if exists). */
  register(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  /** Retrieve a provider by name, throwing if not found. */
  get(name: string): LLMProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = [...this.providers.keys()].join(", ");
      throw new Error(
        `Unknown LLM provider "${name}". Available providers: ${available || "(none)"}`,
      );
    }
    return provider;
  }

  /** Check whether a provider with the given name is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Return a list of registered provider names. */
  list(): string[] {
    return [...this.providers.keys()];
  }
}
