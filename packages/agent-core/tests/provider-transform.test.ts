import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { ProviderTransform } from "../src/providers/transform.js";
import type { ProviderModel } from "../src/providers/types.js";

function makeModel(overrides?: Partial<ProviderModel>): ProviderModel {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: {
      id: "claude-sonnet-4-20250514",
      url: "",
      npm: "@ai-sdk/anthropic",
    },
    capabilities: {
      reasoning: false,
      toolcall: true,
      temperature: true,
      input: { text: true, image: true, pdf: true, audio: false, video: false },
      output: { text: true, image: false, pdf: false, audio: false, video: false },
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    headers: {},
    options: {},
    variants: {},
    ...overrides,
  };
}

const anthropicModel = makeModel();

const geminiModel = makeModel({
  id: "gemini-2.5-flash",
  providerID: "google",
  name: "Gemini 2.5 Flash",
  api: { id: "gemini-2.5-flash", url: "", npm: "@ai-sdk/google" },
});

const openaiModel = makeModel({
  id: "gpt-4o",
  providerID: "openai",
  name: "GPT-4o",
  api: { id: "gpt-4o", url: "", npm: "@ai-sdk/openai" },
});

const bedrockModel = makeModel({
  id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  providerID: "bedrock",
  name: "Claude 3.5 Sonnet (Bedrock)",
  api: { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", url: "", npm: "@ai-sdk/amazon-bedrock" },
});

// --- toolCallId normalization ---

describe("ProviderTransform.messages: toolCallId normalization", () => {
  test("normalizes invalid characters for Anthropic", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call.123/abc", toolName: "test", args: {} },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("call_123_abc");
  });

  test("preserves valid toolCallIds for Anthropic", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "valid_id-123", toolName: "test", args: {} },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("valid_id-123");
  });

  test("skips normalization for non-Anthropic providers", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call.123/abc", toolName: "test", args: {} },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, openaiModel);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("call.123/abc");
  });

  test("normalizes tool-result parts too", () => {
    const msgs: ModelMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call.456", toolName: "test", output: { type: "text", value: "ok" } },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("call_456");
  });
});

// --- Empty content filtering ---

describe("ProviderTransform.messages: empty content filtering", () => {
  test("filters empty text parts for Anthropic", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "tc1", toolName: "test", args: {} },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    const parts = result[0].content as any[];
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("tool-call");
  });

  test("removes messages that are empty string content for Anthropic", () => {
    const msgs: ModelMessage[] = [
      { role: "assistant", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
  });

  test("does not filter for non-Anthropic providers", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "tc1", toolName: "test", args: {} },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, geminiModel);
    const parts = result[0].content as any[];
    expect(parts.length).toBe(2);
  });
});

// --- Foreign metadata stripping ---

describe("ProviderTransform.messages: foreign metadata stripping", () => {
  test("strips non-Anthropic metadata from messages sent to Anthropic", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: "hello",
        providerOptions: {
          google: { thoughtSignature: "sig123" },
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    expect((result[0].providerOptions as any).google).toBeUndefined();
    expect((result[0].providerOptions as any).anthropic).toBeDefined();
  });

  test("removes foreign key, cache control may be added after", () => {
    // stripForeignMetadata removes google key, but applyCacheControl may add anthropic
    // since this is the last message. Test with a non-caching provider to isolate.
    const msgs: ModelMessage[] = [
      {
        role: "user",
        content: "hi",
        providerOptions: { anthropic: { foo: "bar" } },
      },
    ];
    const result = ProviderTransform.messages(msgs, geminiModel);
    // Google has no sdkKey match for 'google' on the providerOptions, and gemini
    // doesn't add cache control, so the foreign 'anthropic' key is stripped
    expect(result[0].providerOptions).toBeUndefined();
  });

  test("strips foreign metadata from parts inside content array", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test",
            args: {},
            providerOptions: {
              google: { thoughtSignature: "sig" },
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
        ],
      },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);
    const part = (result[0].content as any[])[0];
    expect(part.providerOptions.google).toBeUndefined();
    expect(part.providerOptions.anthropic).toBeDefined();
  });
});

// --- Cache control markers ---

describe("ProviderTransform.messages: cache control", () => {
  test("adds Anthropic cache control to system and last 2 messages", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you" },
    ];
    const result = ProviderTransform.messages(msgs, anthropicModel);

    // System message should have cache control
    expect((result[0].providerOptions as any).anthropic.cacheControl).toBeDefined();

    // Last 2 non-system messages should have cache control
    expect((result[2].providerOptions as any)?.anthropic?.cacheControl).toBeDefined();
    expect((result[3].providerOptions as any)?.anthropic?.cacheControl).toBeDefined();
  });

  test("adds Bedrock cache point markers", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.messages(msgs, bedrockModel);
    expect((result[0].providerOptions as any).bedrock.cachePoint).toBeDefined();
  });

  test("does not add cache control for non-Anthropic/Bedrock providers", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.messages(msgs, geminiModel);
    expect(result[0].providerOptions).toBeUndefined();
  });
});

// --- sdkKey mapping via providerOptions ---

describe("ProviderTransform.providerOptions", () => {
  test("maps anthropic npm to 'anthropic' key", () => {
    const result = ProviderTransform.providerOptions(anthropicModel, { foo: "bar" });
    expect(result).toEqual({ anthropic: { foo: "bar" } });
  });

  test("maps google npm to 'google' key", () => {
    const result = ProviderTransform.providerOptions(geminiModel, { thinkingConfig: {} });
    expect(result).toEqual({ google: { thinkingConfig: {} } });
  });

  test("maps openai npm to 'openai' key", () => {
    const result = ProviderTransform.providerOptions(openaiModel, { store: false });
    expect(result).toEqual({ openai: { store: false } });
  });

  test("falls back to providerID for unknown npm", () => {
    const customModel = makeModel({
      providerID: "moonshot",
      api: { id: "kimi-k2.5", url: "", npm: "@ai-sdk/openai-compatible" },
    });
    const result = ProviderTransform.providerOptions(customModel, { x: 1 });
    // openai-compatible has no sdkKey mapping, so falls back to providerID
    expect(result).toEqual({ moonshot: { x: 1 } });
  });
});

// --- maxOutputTokens capping ---

describe("ProviderTransform.maxOutputTokens", () => {
  test("caps at 32K when model limit is higher", () => {
    const model = makeModel({ limit: { context: 200000, output: 65536 } });
    expect(ProviderTransform.maxOutputTokens(model)).toBe(32_000);
  });

  test("uses model limit when lower than 32K", () => {
    const model = makeModel({ limit: { context: 200000, output: 8192 } });
    expect(ProviderTransform.maxOutputTokens(model)).toBe(8192);
  });

  test("returns 32K when model limit is exactly 32K", () => {
    const model = makeModel({ limit: { context: 200000, output: 32000 } });
    expect(ProviderTransform.maxOutputTokens(model)).toBe(32_000);
  });

  test("returns 32K when model limit is 0", () => {
    const model = makeModel({ limit: { context: 200000, output: 0 } });
    expect(ProviderTransform.maxOutputTokens(model)).toBe(32_000);
  });
});

// --- Temperature defaults ---

describe("ProviderTransform.temperature", () => {
  test("returns undefined for Claude models", () => {
    expect(ProviderTransform.temperature(anthropicModel)).toBeUndefined();
  });

  test("returns 1.0 for Gemini models", () => {
    expect(ProviderTransform.temperature(geminiModel)).toBe(1.0);
  });

  test("returns undefined for other models", () => {
    expect(ProviderTransform.temperature(openaiModel)).toBeUndefined();
  });
});

// --- options ---

describe("ProviderTransform.options", () => {
  test("returns thinkingConfig for Google provider", () => {
    const opts = ProviderTransform.options(geminiModel);
    expect(opts.thinkingConfig).toEqual({ includeThoughts: true });
  });

  test("returns store: false for OpenAI provider", () => {
    const opts = ProviderTransform.options(openaiModel);
    expect(opts.store).toBe(false);
  });

  test("returns empty object for Anthropic", () => {
    const opts = ProviderTransform.options(anthropicModel);
    expect(Object.keys(opts).length).toBe(0);
  });
});
