import type { ModelMessage } from "@tanstack/ai";
import type { SessionMessage } from "./types.js";

export interface SerializedSession {
  messages: SessionMessage[];
}

let messageCounter = 0;

export function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
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

  toModelMessages(): ModelMessage[] {
    return this.messages.map((msg): ModelMessage => {
      const modelMsg: ModelMessage = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.toolCalls) {
        modelMsg.toolCalls = msg.toolCalls;
      }
      if (msg.toolCallId) {
        modelMsg.toolCallId = msg.toolCallId;
      }
      return modelMsg;
    });
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  /** Serialize session state to a plain object for persistence. */
  serialize(): SerializedSession {
    return {
      messages: this.messages.map((m) => ({ ...m })),
    };
  }

  /** Reconstruct a Session from serialized data. */
  static deserialize(data: SerializedSession): Session {
    const session = new Session();
    for (const msg of data.messages) {
      session.messages.push({ ...msg });
    }
    return session;
  }
}
