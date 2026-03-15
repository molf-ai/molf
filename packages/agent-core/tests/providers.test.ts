import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { Env } from "../src/env.js";

vi.mock("../src/providers/catalog.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/providers/catalog.js")>();
  return {
    ...orig,
    getCatalog: vi.fn(),
  };
});

import { getCatalog, resetCatalog } from "../src/providers/catalog.js";
import {
  initProviders,
  getModel,
  listProviders,
  listModels,
  resolveLanguageModel,
} from "../src/providers/registry.js";

const FAKE_CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        release_date: "2025-05-14",
        reasoning: false,
        tool_call: true,
        temperature: true,
        attachment: true,
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        release_date: "2025-03-01",
        reasoning: true,
        tool_call: true,
        temperature: true,
        attachment: true,
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 1048576, output: 65536 },
      },
    },
  },
};

let env: EnvGuard;

beforeEach(() => {
  env = createEnvGuard();
  resetCatalog();
  vi.mocked(getCatalog).mockResolvedValue(FAKE_CATALOG);
});

afterEach(() => {
  env.restore();
  Env.reset();
  resetCatalog();
});

// --- initProviders ---

describe("initProviders", () => {
  test("initializes with catalog providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "test-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.anthropic.name).toBe("Anthropic");
  });

  test("includes models from catalog", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const models = listModels(state, "anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("claude-sonnet-4-20250514");
  });
});

describe("initProviders: env detection", () => {
  test("detects provider when API key env var is set", async () => {
    Env.set("ANTHROPIC_API_KEY", "test-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.anthropic.key).toBe("test-key");
    expect(state.providers.anthropic.source).toBe("env");
  });

  test("excludes provider when API key is not set", async () => {
    Env.delete_("ANTHROPIC_API_KEY");
    Env.delete_("GEMINI_API_KEY");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(state.providers.anthropic).toBeUndefined();
  });
});

describe("initProviders: enablement filtering", () => {
  test("default model's provider is always enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    // Anthropic enabled (default model), google NOT (not in enabled_providers)
    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeUndefined();
  });

  test("enabled_providers adds extra providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeDefined();
  });

  test("enable_all_providers enables everything with a key", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enable_all_providers: true,
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeDefined();
  });

  test("config providers are implicitly enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");
    Env.set("MOONSHOT_API_KEY", "moon-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      providers: {
        moonshot: {
          env: ["MOONSHOT_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "kimi-k2.5": {
              name: "Kimi K2.5",
              limit: { context: 256000, output: 8192 },
            },
          },
        },
      },
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.moonshot).toBeDefined();
    expect(state.providers.moonshot.models["kimi-k2.5"]).toBeDefined();
  });
});

// --- getModel ---

describe("getModel", () => {
  test("returns model for valid provider and model ID", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const model = getModel(state, "anthropic", "claude-sonnet-4-20250514");
    expect(model.providerID).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-4-20250514");
    expect(model.limit.context).toBe(200000);
  });

  test("throws for unknown provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(() => getModel(state, "nonexistent", "test")).toThrow(
      'Unknown provider "nonexistent"',
    );
  });

  test("throws for unknown model", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(() => getModel(state, "anthropic", "nonexistent")).toThrow(
      'Unknown model "nonexistent"',
    );
  });
});

// --- listProviders ---

describe("listProviders", () => {
  test("returns enabled providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const providers = listProviders(state);
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("anthropic");
  });

  test("returns multiple providers when enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const providers = listProviders(state);
    expect(providers.length).toBe(2);
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "google"]);
  });
});

// --- listModels ---

describe("listModels", () => {
  test("returns all models without filter", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const models = listModels(state);
    expect(models.length).toBe(2);
  });

  test("filters by provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const anthropicModels = listModels(state, "anthropic");
    const googleModels = listModels(state, "google");
    expect(anthropicModels.length).toBe(1);
    expect(anthropicModels[0].providerID).toBe("anthropic");
    expect(googleModels.every((m) => m.providerID === "google")).toBe(true);
  });

  test("returns empty array for unknown provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const models = listModels(state, "nonexistent");
    expect(models).toEqual([]);
  });
});

// --- resolveLanguageModel ---

describe("resolveLanguageModel", () => {
  test("resolves a language model from provider state", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const model = getModel(state, "anthropic", "claude-sonnet-4-20250514");
    const lm = await resolveLanguageModel(state, model);
    expect(lm).toBeDefined();
    expect((lm as any).modelId).toBe("claude-sonnet-4-20250514");
  });
});
