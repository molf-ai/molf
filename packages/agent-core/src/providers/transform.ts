import type { ModelMessage } from "ai";
import type { ProviderModel } from "./types.js";

export namespace ProviderTransform {
  const OUTPUT_TOKEN_MAX = 32_000;

  /** Map npm package → AI SDK providerOptions key. */
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return "openai";
      case "@ai-sdk/anthropic":
        return "anthropic";
      case "@ai-sdk/amazon-bedrock":
        return "bedrock";
      case "@ai-sdk/google":
      case "@ai-sdk/google-vertex":
        return "google";
      case "@openrouter/ai-sdk-provider":
        return "openrouter";
    }
    return undefined;
  }

  // --- Message transforms ---

  /** Main entry: normalize messages for the target provider. */
  export function messages(
    msgs: ModelMessage[],
    model: ProviderModel,
  ): ModelMessage[] {
    msgs = filterEmptyContent(msgs, model);
    msgs = normalizeToolCallIds(msgs, model);
    msgs = stripForeignMetadata(msgs, model);
    msgs = applyCacheControl(msgs, model);
    return msgs;
  }

  /** Anthropic rejects empty text/reasoning parts. */
  function filterEmptyContent(
    msgs: ModelMessage[],
    model: ProviderModel,
  ): ModelMessage[] {
    if (model.api.npm !== "@ai-sdk/anthropic") return msgs;
    return msgs
      .map((msg) => {
        if (typeof msg.content === "string")
          return msg.content === "" ? undefined : msg;
        if (!Array.isArray(msg.content)) return msg;
        const filtered = (msg.content as any[]).filter((part: any) =>
          part.type === "text" || part.type === "reasoning"
            ? part.text !== ""
            : true,
        );
        return filtered.length === 0
          ? undefined
          : { ...msg, content: filtered };
      })
      .filter(Boolean) as ModelMessage[];
  }

  /** Claude toolCallIds must be [a-zA-Z0-9_-]. */
  function normalizeToolCallIds(
    msgs: ModelMessage[],
    model: ProviderModel,
  ): ModelMessage[] {
    if (
      model.api.npm !== "@ai-sdk/anthropic" &&
      !model.api.id.includes("claude")
    )
      return msgs;
    return msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: (msg.content as any[]).map((part: any) => {
          if (
            (part.type === "tool-call" || part.type === "tool-result") &&
            "toolCallId" in part
          ) {
            return {
              ...part,
              toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
            };
          }
          return part;
        }),
      } as ModelMessage;
    });
  }

  /** Strip provider-specific metadata from messages produced by a different provider. */
  function stripForeignMetadata(
    msgs: ModelMessage[],
    model: ProviderModel,
  ): ModelMessage[] {
    const currentKey = sdkKey(model.api.npm) ?? model.providerID;
    return msgs.map((msg) => {
      if (!Array.isArray(msg.content)) {
        return {
          ...msg,
          providerOptions: keepKey(msg.providerOptions, currentKey),
        } as ModelMessage;
      }
      return {
        ...msg,
        providerOptions: keepKey(msg.providerOptions, currentKey),
        content: (msg.content as any[]).map((part: any) =>
          "providerOptions" in part
            ? {
                ...part,
                providerOptions: keepKey(part.providerOptions, currentKey),
              }
            : part,
        ),
      } as ModelMessage;
    });
  }

  function keepKey(
    opts: any,
    key: string,
  ): Record<string, any> | undefined {
    if (!opts || !(key in opts)) return undefined;
    return { [key]: opts[key] };
  }

  /** Apply cache control markers for Anthropic/Bedrock. */
  function applyCacheControl(
    msgs: ModelMessage[],
    model: ProviderModel,
  ): ModelMessage[] {
    if (
      model.api.npm !== "@ai-sdk/anthropic" &&
      model.api.npm !== "@ai-sdk/amazon-bedrock"
    )
      return msgs;
    const marker: Record<string, Record<string, unknown>> =
      model.api.npm === "@ai-sdk/amazon-bedrock"
        ? { bedrock: { cachePoint: { type: "default" } } }
        : { anthropic: { cacheControl: { type: "ephemeral" } } };
    const systemMsgs = msgs.filter((m) => m.role === "system").slice(0, 2);
    const lastMsgs = msgs.filter((m) => m.role !== "system").slice(-2);
    const targets = new Set([...systemMsgs, ...lastMsgs]);
    return msgs.map((msg) =>
      targets.has(msg)
        ? ({
            ...msg,
            providerOptions: { ...(msg.providerOptions as any), ...marker },
          } as unknown as ModelMessage)
        : msg,
    );
  }

  // --- Call-level options ---

  /** Get provider-specific options for streamText(). */
  export function options(
    model: ProviderModel,
    _sessionID: string,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (
      model.api.npm === "@ai-sdk/google" ||
      model.api.npm === "@ai-sdk/google-vertex"
    ) {
      result["thinkingConfig"] = { includeThoughts: true };
    }
    if (model.api.npm === "@ai-sdk/openai") {
      result["store"] = false;
    }
    return result;
  }

  /** Wrap raw options in the correct providerOptions key. */
  export function providerOptions(
    model: ProviderModel,
    opts: Record<string, unknown>,
  ): Record<string, unknown> {
    const key = sdkKey(model.api.npm) ?? model.providerID;
    return { [key]: opts };
  }

  /** Get default temperature for this model. */
  export function temperature(model: ProviderModel): number | undefined {
    const id = model.id.toLowerCase();
    if (id.includes("claude")) return undefined;
    if (id.includes("gemini")) return 1.0;
    return undefined;
  }

  /** Cap output tokens to model limit. */
  export function maxOutputTokens(model: ProviderModel): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
  }
}
