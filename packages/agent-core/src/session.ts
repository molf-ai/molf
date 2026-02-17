import type { ModelMessage, ToolCallPart, TextPart, ImagePart, FilePart as AISdkFilePart } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { SessionMessage } from "./types.js";

export interface SerializedSession {
  messages: SessionMessage[];
}

export function generateMessageId(): string {
  return `msg_${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Convert session messages to Vercel AI SDK ModelMessage[] format.
 *
 * - User (no attachments) -> { role: "user", content: string }
 * - User (with attachments) -> { role: "user", content: [TextPart?, ...ImagePart | FilePart] }
 * - Assistant without tools -> { role: "assistant", content: string }
 * - Assistant with toolCalls -> { role: "assistant", content: [TextPart, ...ToolCallParts] }
 * - Tool -> { role: "tool", content: [ToolResultPart] }
 */
export function convertToModelMessages(messages: readonly SessionMessage[]): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    if (msg.role === "user") {
      if (!msg.attachments?.length) {
        return { role: "user", content: msg.content };
      }

      const parts: Array<TextPart | ImagePart | AISdkFilePart> = [];

      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }

      for (const att of msg.attachments ?? []) {
        if (att.mimeType.startsWith("image/")) {
          parts.push({ type: "image", image: att.data, mediaType: att.mimeType });
        } else {
          parts.push({ type: "file", data: att.data, mediaType: att.mimeType });
        }
      }

      return { role: "user", content: parts };
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
   * - User (no attachments) → { role: "user", content: string }
   * - User (with attachments) → { role: "user", content: [TextPart?, ...ImagePart | FilePart] }
   * - Assistant without tools → { role: "assistant", content: string }
   * - Assistant with toolCalls → { role: "assistant", content: [TextPart, ...ToolCallParts] }
   * - Tool → { role: "tool", content: [ToolResultPart] }
   */
  toModelMessages(): ModelMessage[] {
    return convertToModelMessages(this.messages);
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  /**
   * Shallow-serialize session data. WARNING: Messages with ResolvedAttachment
   * (Uint8Array data) will not survive JSON.stringify — use only for in-memory
   * transfers or tests, not disk persistence.
   */
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
