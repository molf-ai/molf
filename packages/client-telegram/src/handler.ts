import type { Context } from "grammy";
import type { SessionMap } from "./session-map.js";
import type { ServerConnection } from "./connection.js";
import type { Renderer } from "./renderer.js";

export interface HandlerDeps {
  sessionMap: SessionMap;
  connection: ServerConnection;
  renderer: Renderer;
  ackReaction: string;
}

/**
 * Text fragment buffering for messages near Telegram's ~4096 char limit.
 * Telegram may split long user pastes into multiple messages.
 */
interface BufferEntry {
  chatId: number;
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
  totalLength: number;
}

const MAX_BUFFER_PARTS = 12;
const BUFFER_TIMEOUT_MS = 1500;
const MAX_BUFFER_SIZE = 50_000;

export class MessageHandler {
  private deps: HandlerDeps;
  private buffers = new Map<number, BufferEntry>();

  constructor(deps: HandlerDeps) {
    this.deps = deps;
  }

  /**
   * Handle an incoming text message.
   * Implements fragment buffering for long pastes.
   */
  async handleMessage(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!chatId || !text) return;

    // Check if there's an active buffer for this chat — append to it
    const buffer = this.buffers.get(chatId);
    if (buffer) {
      this.bufferFragment(chatId, text, ctx);
      return;
    }

    // Check if this is a potential multi-part paste (near Telegram's limit)
    if (text.length >= 4000) {
      this.bufferFragment(chatId, text, ctx);
      return;
    }

    // Normal message — process directly
    await this.processMessage(chatId, text, ctx);
  }

  private bufferFragment(chatId: number, text: string, ctx: Context) {
    const existing = this.buffers.get(chatId);

    if (existing) {
      clearTimeout(existing.timer);

      // Check limits
      if (
        existing.parts.length >= MAX_BUFFER_PARTS ||
        existing.totalLength + text.length > MAX_BUFFER_SIZE
      ) {
        // Buffer full — flush what we have and process this as new
        const combined = existing.parts.join("\n");
        this.buffers.delete(chatId);
        this.processMessage(chatId, combined, ctx);

        const timer = setTimeout(() => {
          const entry = this.buffers.get(chatId);
          if (entry) {
            const combinedEntry = entry.parts.join("\n");
            this.buffers.delete(chatId);
            this.processMessage(chatId, combinedEntry, ctx);
          }
        }, BUFFER_TIMEOUT_MS);

        this.buffers.set(chatId, {
          chatId,
          parts: [text],
          timer,
          totalLength: text.length,
        });
        return;
      }

      existing.parts.push(text);
      existing.totalLength += text.length;
      existing.timer = setTimeout(() => {
        const entry = this.buffers.get(chatId);
        if (entry) {
          const combined = entry.parts.join("\n");
          this.buffers.delete(chatId);
          this.processMessage(chatId, combined, ctx);
        }
      }, BUFFER_TIMEOUT_MS);
    } else {
      const timer = setTimeout(() => {
        const entry = this.buffers.get(chatId);
        if (entry) {
          const combined = entry.parts.join("\n");
          this.buffers.delete(chatId);
          this.processMessage(chatId, combined, ctx);
        }
      }, BUFFER_TIMEOUT_MS);

      this.buffers.set(chatId, {
        chatId,
        parts: [text],
        timer,
        totalLength: text.length,
      });
    }
  }

  private async processMessage(chatId: number, text: string, ctx: Context) {
    try {
      // 1. React with acknowledgment emoji
      await this.sendAckReaction(ctx);

      // 2. Send typing indicator
      await ctx.api.sendChatAction(chatId, "typing");

      // 3. Resolve or create session
      const sessionId = await this.deps.sessionMap.getOrCreate(chatId);

      // 4. Start rendering events for this session
      this.deps.renderer.startSession(chatId, sessionId);

      // 5. Submit prompt to agent
      await this.deps.connection.trpc.agent.prompt.mutate({
        sessionId,
        text,
      });
    } catch (err) {
      console.error("[telegram] Error processing message:", err);
      try {
        await ctx.reply(
          "Something went wrong processing your message. Try /new to start fresh.",
        );
      } catch {
        // If we can't even reply, just log
      }
    }
  }

  private async sendAckReaction(ctx: Context) {
    const messageId = ctx.message?.message_id;
    const chatId = ctx.chat?.id;
    if (!messageId || !chatId) return;

    try {
      await ctx.api.setMessageReaction(chatId, messageId, [
        { type: "emoji", emoji: this.deps.ackReaction as any },
      ]);
    } catch {
      // Reaction API might not be available — ignore
    }
  }

  /**
   * Clean up any pending buffers.
   */
  cleanup() {
    for (const [, entry] of this.buffers) {
      clearTimeout(entry.timer);
    }
    this.buffers.clear();
  }
}
