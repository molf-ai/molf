import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { mockTextResponse } from "@molf-ai/test-utils";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { startTestServer, createTestClient } from "../../helpers/index.js";
import type { TestServer } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

let server: TestServer;

beforeAll(async () => {
  setStreamTextImpl(() => mockTextResponse("ok"));
  server = await startTestServer();
});

afterAll(() => {
  server.cleanup();
});

describe("Provider setup flow", () => {
  test("listProviders returns catalog providers with hasKey/keySource", async () => {
    const { client, cleanup } = createTestClient(server.url, server.token);
    try {
      const { providers } = await client.provider.listProviders();
      expect(providers.length).toBeGreaterThan(0);

      const google = providers.find((p: any) => p.id === "google");
      expect(google).toBeDefined();
      expect(google!.hasKey).toBe(true);
      expect(google!.modelCount).toBeGreaterThan(0);

      for (const p of providers) {
        expect(p).toHaveProperty("id");
        expect(p).toHaveProperty("name");
        expect(p).toHaveProperty("modelCount");
        expect(p).toHaveProperty("hasKey");
        expect(p).toHaveProperty("keySource");
        expect(["env", "stored", "none"]).toContain(p.keySource);
      }
    } finally {
      cleanup();
    }
  });

  test("listModels requires providerID and returns only that provider's models", async () => {
    const { client, cleanup } = createTestClient(server.url, server.token);
    try {
      const { models } = await client.provider.listModels({ providerID: "google" });
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.providerID).toBe("google");
      }
    } finally {
      cleanup();
    }
  });

  test("setKey makes provider models available", async () => {
    const { client, cleanup } = createTestClient(server.url, server.token);
    try {
      await client.provider.setKey({ providerID: "anthropic", key: "test-anthropic-key" });

      const { models } = await client.provider.listModels({ providerID: "anthropic" });
      expect(models.length).toBeGreaterThan(0);

      const { providers } = await client.provider.listProviders();
      const anthropic = providers.find((p: any) => p.id === "anthropic");
      expect(anthropic!.hasKey).toBe(true);
      expect(anthropic!.keySource).toBe("stored");

      await client.provider.removeKey({ providerID: "anthropic" });
    } finally {
      cleanup();
    }
  });

  test("removeKey removes provider models", async () => {
    const { client, cleanup } = createTestClient(server.url, server.token);
    try {
      await client.provider.setKey({ providerID: "anthropic", key: "test-key" });
      const withKey = await client.provider.listModels({ providerID: "anthropic" });
      expect(withKey.models.length).toBeGreaterThan(0);

      await client.provider.removeKey({ providerID: "anthropic" });
      const withoutKey = await client.provider.listModels({ providerID: "anthropic" });
      expect(withoutKey.models.length).toBe(0);

      const { providers } = await client.provider.listProviders();
      const anthropic = providers.find((p: any) => p.id === "anthropic");
      expect(anthropic!.hasKey).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("config.set model works after provider key is set", async () => {
    const { client, cleanup } = createTestClient(server.url, server.token);
    try {
      await client.provider.setKey({ providerID: "anthropic", key: "test-key" });

      const { models } = await client.provider.listModels({ providerID: "anthropic" });
      expect(models.length).toBeGreaterThan(0);

      const modelId = models[0].id;
      const result = await client.config.set({ path: ["model"], value: modelId });
      expect(result.ok).toBe(true);

      const config = await client.config.get();
      expect(config.model).toBe(modelId);

      await client.provider.removeKey({ providerID: "anthropic" });
    } finally {
      cleanup();
    }
  });
});
