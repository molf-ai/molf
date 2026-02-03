import type { ModelMessage, ToolCallPart, TextPart } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { SessionMessage } from "./types.js";

export interface SerializedSession {
  messages: SessionMessage[];
}

export function generateMessageId(): string {
  return `msg_${crypto.randomUUID().slice(0, 12)}`;
}

export class Session {
  private messages: SessionMessage[] = [];

  addMessage(
    message: Omit<SessionMessage, "id" | "timestamp">,
  ): SessionMessage {
    const full: SessionMessage = {
      ...message,
      id: generateMessageId(),
      timestamp: Date.now(),
    };
    this.messages.push(full);
    return full;
  }

  getMessages(): readonly SessionMessage[] {
    return this.messages;
  }

  getLastMessage(): SessionMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Convert session messages to Vercel AI SDK ModelMessage[] format.
   *
   * - User → { role: "user", content: string }
   * - Assistant without tools → { role: "assistant", content: string }
   * - Assistant with toolCalls → { role: "assistant", content: [TextPart, ...ToolCallParts] }
   * - Tool → { role: "tool", content: [ToolResultPart] }
   */
  toModelMessages(): ModelMessage[] {
    return this.messages.map((msg): ModelMessage => {
      if (msg.role === "user") {
        return { role: "user", content: msg.content };
      }

      if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const parts: Array<TextPart | ToolCallPart> = [];

          if (msg.content) {
            parts.push({ type: "text", text: msg.content });
          }

          for (const tc of msg.toolCalls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args,
              ...(tc.providerMetadata
                ? {
                    providerOptions:
                      tc.providerMetadata as ToolCallPart["providerOptions"],
                  }
                : {}),
            });
          }

          return { role: "assistant", content: parts };
        }

        return { role: "assistant", content: msg.content };
      }

      // role === "tool"
      // Build ToolResultOutput: try JSON parse for structured data, else text
      let output: { type: "text"; value: string } | { type: "json"; value: JSONValue };
      try {
        const parsed = JSON.parse(msg.content) as JSONValue;
        output = { type: "json", value: parsed };
      } catch {
        output = { type: "text", value: msg.content };
      }

      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId!,
            toolName: msg.toolName ?? "unknown",
            output,
          },
        ],
      };
    });
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  serialize(): SerializedSession {
    return {
      messages: this.messages.map((m) => ({ ...m })),
    };
  }

  static deserialize(data: SerializedSession): Session {
    const session = new Session();
    for (const msg of data.messages) {
      session.messages.push({ ...msg });
    }
    return session;
  }
}
