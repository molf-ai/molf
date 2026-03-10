import { describe, test, expect } from "vitest";
import { CUSTOM_LOADERS } from "../src/providers/custom-loaders.js";

describe("CUSTOM_LOADERS", () => {
  test("has loaders for anthropic and openai", () => {
    expect(CUSTOM_LOADERS.anthropic).toBeDefined();
    expect(CUSTOM_LOADERS.openai).toBeDefined();
  });
});

describe("anthropic loader", () => {
  test("injects anthropic-beta header", () => {
    const result = CUSTOM_LOADERS.anthropic();
    expect(result.options).toBeDefined();
    expect(result.options!.headers).toBeDefined();
    expect((result.options!.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14",
    );
  });

  test("does not provide a custom getModel", () => {
    const result = CUSTOM_LOADERS.anthropic();
    expect(result.getModel).toBeUndefined();
  });
});

describe("openai loader", () => {
  test("provides a custom getModel", () => {
    const result = CUSTOM_LOADERS.openai();
    expect(typeof result.getModel).toBe("function");
  });

  test("does not provide extra options", () => {
    const result = CUSTOM_LOADERS.openai();
    expect(result.options).toBeUndefined();
  });

  test("GPT-5 routes to sdk.responses()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "gpt-5", {});
    expect((model as any).api).toBe("responses");
    expect((model as any).modelId).toBe("gpt-5");
  });

  test("GPT-5-turbo routes to sdk.responses()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "gpt-5-turbo", {});
    expect((model as any).api).toBe("responses");
  });

  test("GPT-4 routes to sdk.chat()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "gpt-4", {});
    expect((model as any).api).toBe("chat");
    expect((model as any).modelId).toBe("gpt-4");
  });

  test("GPT-4o routes to sdk.chat()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "gpt-4o", {});
    expect((model as any).api).toBe("chat");
  });

  test("GPT-6 routes to sdk.responses()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "gpt-6", {});
    expect((model as any).api).toBe("responses");
  });

  test("non-GPT model falls through to sdk.chat()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "o1-mini", {});
    expect((model as any).api).toBe("chat");
  });

  test("model name with no gpt prefix falls through to sdk.chat()", () => {
    const result = CUSTOM_LOADERS.openai();
    const mockSDK = {
      responses: (id: string) => ({ api: "responses", modelId: id }),
      chat: (id: string) => ({ api: "chat", modelId: id }),
    };
    const model = result.getModel!(mockSDK, "dall-e-3", {});
    expect((model as any).api).toBe("chat");
  });
});
