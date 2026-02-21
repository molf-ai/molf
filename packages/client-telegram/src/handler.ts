import type { Context } from "grammy";
import { InputFile } from "grammy";
import { TRPCClientError } from "@trpc/client";
import type { SessionMap } from "./session-map.js";
import type { ServerConnection } from "./connection.js";
import type { Renderer } from "./renderer.js";
import { escapeHtml } from "./format.js";
import { downloadTelegramMedia, FileTooLargeError, type DownloadedMedia } from "./media.js";

export interface HandlerDeps {
  sessionMap: SessionMap;
  connection: ServerConnection;
  renderer: Renderer;
  ackReaction: string;
  botToken: string;
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

/**
 * Media group buffering for Telegram albums.
 * When a user sends multiple images as an album, Telegram fires a separate
 * event per image. We collect them and send as a single prompt.
 */
interface MediaGroupEntry {
  chatId: number;
  items: DownloadedMedia[];
  caption: string;
  timer: ReturnType<typeof setTimeout>;
  ctx: Context; // keep last ctx for ack/reply
}

const MAX_BUFFER_PARTS = 12;
const BUFFER_TIMEOUT_MS = 1500;
const MAX_BUFFER_SIZE = 50_000;
const MEDIA_GROUP_TIMEOUT_MS = 500;
const SHELL_INLINE_LIMIT = 3000;

export class MessageHandler {
  private deps: HandlerDeps;
  private buffers = new Map<number, BufferEntry>();
  private mediaGroups = new Map<string, MediaGroupEntry>();

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

  /**
   * Handle an incoming media message (photo, document, audio, video, sticker).
   * When the message belongs to a media group (album), items are buffered and
   * sent together as a single prompt with multiple attachments.
   */
  async handleMedia(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const mediaGroupId = ctx.message?.media_group_id;

    try {
      // Download media from Telegram
      const media = await downloadTelegramMedia(ctx, this.deps.botToken);

      if (mediaGroupId) {
        // Buffer this item for grouped sending
        this.bufferMediaGroupItem(mediaGroupId, chatId, media, ctx);
        return;
      }

      // Single media — upload to worker first, then prompt with fileRef
      await this.sendAckReaction(ctx);
      await ctx.api.sendChatAction(chatId, "typing");
      const sessionId = await this.deps.sessionMap.getOrCreate(chatId);
      this.deps.renderer.startSession(chatId, sessionId);

      const { path, mimeType } = await this.deps.connection.trpc.agent.upload.mutate({
        sessionId,
        data: Buffer.from(media.buffer).toString("base64"),
        filename: media.filename,
        mimeType: media.mimeType,
      });

      await this.deps.connection.trpc.agent.prompt.mutate({
        sessionId,
        text: ctx.message?.caption ?? ctx.message?.sticker?.emoji ?? "",
        fileRefs: [{ path, mimeType }],
      });
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        try {
          await ctx.reply(err.message);
        } catch { /* ignore reply failure */ }
        return;
      }
      console.error("[telegram] Error processing media:", err);
      try {
        await ctx.reply("Something went wrong processing your media. Try again or send text instead.");
      } catch { /* ignore reply failure */ }
    }
  }

  private bufferMediaGroupItem(
    mediaGroupId: string,
    chatId: number,
    media: DownloadedMedia,
    ctx: Context,
  ) {
    const existing = this.mediaGroups.get(mediaGroupId);

    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(media);
      // Keep the first non-empty caption
      if (!existing.caption) {
        existing.caption = ctx.message?.caption ?? "";
      }
      existing.ctx = ctx;
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT_MS);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT_MS);
      this.mediaGroups.set(mediaGroupId, {
        chatId,
        items: [media],
        caption: ctx.message?.caption ?? "",
        timer,
        ctx,
      });
    }
  }

  private async flushMediaGroup(mediaGroupId: string) {
    const entry = this.mediaGroups.get(mediaGroupId);
    if (!entry) return;
    this.mediaGroups.delete(mediaGroupId);

    try {
      await this.sendAckReaction(entry.ctx);
      await entry.ctx.api.sendChatAction(entry.chatId, "typing");
      const sessionId = await this.deps.sessionMap.getOrCreate(entry.chatId);
      this.deps.renderer.startSession(entry.chatId, sessionId);

      // Upload each item to worker, collect fileRefs
      const fileRefs: Array<{ path: string; mimeType: string }> = [];
      for (const item of entry.items) {
        const { path, mimeType } = await this.deps.connection.trpc.agent.upload.mutate({
          sessionId,
          data: Buffer.from(item.buffer).toString("base64"),
          filename: item.filename,
          mimeType: item.mimeType,
        });
        fileRefs.push({ path, mimeType });
      }

      await this.deps.connection.trpc.agent.prompt.mutate({
        sessionId,
        text: entry.caption,
        fileRefs,
      });
    } catch (err) {
      console.error("[telegram] Error processing media group:", err);
      try {
        await entry.ctx.reply("Something went wrong processing your media. Try again or send text instead.");
      } catch { /* ignore reply failure */ }
    }
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
    if (text.startsWith("!!")) {
      const command = text.slice(2).trimStart();
      if (command.length === 0) {
        await ctx.reply("Usage: !!<command>  (fire-and-forget, not saved to context)");
        return;
      }
      await this.handleShellExec(chatId, command, ctx, false);
      return;
    }

    if (text.startsWith("!")) {
      const command = text.slice(1).trimStart();
      if (command.length === 0) {
        await ctx.reply("Usage: !<command>  (e.g. !ls -la)");
        return;
      }
      await this.handleShellExec(chatId, command, ctx, true);
      return;
    }

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
        let message = "Something went wrong processing your message. Try /new to start fresh.";
        if (err instanceof TRPCClientError) {
          const code = (err as any).data?.code as string | undefined;
          if (code === "CONFLICT") {
            message = "Please wait for the current response to finish before sending another message.";
          }
        }
        await ctx.reply(message);
      } catch {
        // If we can't even reply, just log
      }
    }
  }

  private async handleShellExec(chatId: number, command: string, ctx: Context, saveToSession?: boolean): Promise<void> {
    await ctx.api.sendChatAction(chatId, "typing");
    const sessionId = await this.deps.sessionMap.getOrCreate(chatId);
    try {
      const result = await this.deps.connection.trpc.agent.shellExec.mutate({ sessionId, command, saveToSession });
      const combinedLength = result.stdout.length + result.stderr.length;
      const isTruncated = result.stdoutTruncated || result.stderrTruncated;

      if (combinedLength <= SHELL_INLINE_LIMIT) {
        // Tier 1: Small output — inline
        const msg = formatShellResult(command, result, "full", saveToSession);
        await ctx.reply(msg, { parse_mode: "HTML" });
      } else if (!isTruncated) {
        // Tier 2: Medium output (not truncated) — inline summary + file from response data
        const summaryMsg = formatShellResult(command, result, "summary", saveToSession);
        await ctx.reply(summaryMsg, { parse_mode: "HTML" });
        const fileText = buildFullOutputText(command, result);
        await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(fileText), "output.txt"));
      } else {
        // Tier 3: Large output (truncated) — inline summary + file via fs.read
        const summaryMsg = formatShellResult(command, result, "summary", saveToSession);
        await ctx.reply(summaryMsg, { parse_mode: "HTML" });
        await this.sendTruncatedOutputFile(chatId, sessionId, command, result, ctx);
      }
    } catch (err) {
      let message = "Something went wrong running the command.";
      if (err instanceof TRPCClientError) {
        const code = err.data?.code as string | undefined;
        if (code === "CONFLICT") {
          message = "Agent is busy. Wait for the current operation to finish, or use !! to run without saving to context.";
        } else if (code === "PRECONDITION_FAILED") {
          message = "Worker not connected. Use /worker to select a worker.";
        } else if (code === "NOT_FOUND") {
          message = "Session not found. Use /new to start a session.";
        } else if (code === "TIMEOUT") {
          message = "Command timed out after 120 seconds.";
        } else if (code === "INTERNAL_SERVER_ERROR") {
          message = `Shell execution failed: ${err.message}`;
        }
      }
      try {
        await ctx.reply(message);
      } catch {
        // If we can't even reply, just log
      }
    }
  }

  /**
   * Fetch full output via fs.read and send as file attachment.
   * Falls back to sending the truncated response data if fs.read fails.
   */
  private async sendTruncatedOutputFile(
    chatId: number,
    sessionId: string,
    command: string,
    result: { stdout: string; stderr: string; exitCode: number; stdoutOutputPath?: string; stderrOutputPath?: string },
    ctx: Context,
  ): Promise<void> {
    const parts: string[] = [`$ ${command}`, `Exit: ${result.exitCode}`, ""];

    // Try to fetch full stdout via fs.read
    if (result.stdoutOutputPath) {
      try {
        const fsResult = await this.deps.connection.trpc.fs.read.mutate({
          sessionId,
          path: result.stdoutOutputPath,
        });
        parts.push("=== stdout ===", fsResult.content);
      } catch {
        // Fallback to truncated stdout from response
        parts.push("=== stdout (truncated) ===", result.stdout);
      }
    } else {
      parts.push("=== stdout ===", result.stdout);
    }

    parts.push("");

    // Try to fetch full stderr via fs.read
    if (result.stderrOutputPath) {
      try {
        const fsResult = await this.deps.connection.trpc.fs.read.mutate({
          sessionId,
          path: result.stderrOutputPath,
        });
        parts.push("=== stderr ===", fsResult.content);
      } catch {
        parts.push("=== stderr (truncated) ===", result.stderr);
      }
    } else {
      parts.push("=== stderr ===", result.stderr);
    }

    const fileText = parts.join("\n");
    try {
      await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(fileText), "output.txt"));
    } catch {
      // If document send fails, ignore — summary was already sent
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
    for (const [, entry] of this.mediaGroups) {
      clearTimeout(entry.timer);
    }
    this.mediaGroups.clear();
  }
}

function formatShellResult(
  command: string,
  result: { stdout: string; stderr: string; exitCode: number; stdoutTruncated?: boolean; stderrTruncated?: boolean },
  mode: "full" | "summary",
  saveToSession?: boolean,
): string {
  const lines: string[] = [];
  lines.push(`<b>$ ${escapeHtml(command)}</b>`);
  lines.push(`<b>Exit: ${result.exitCode}</b>${result.exitCode !== 0 ? " (error)" : ""}`);
  if (saveToSession) lines.push("<i>[saved to context]</i>");
  lines.push("");

  if (mode === "full") {
    if (result.stdout || result.stderr) {
      if (result.stdout) {
        lines.push("<b>stdout:</b>");
        lines.push(`<pre><code>${escapeHtml(result.stdout)}</code></pre>`);
        if (result.stdoutTruncated) lines.push("<i>[stdout truncated]</i>");
      }
      if (result.stderr) {
        lines.push("<b>stderr:</b>");
        lines.push(`<pre><code>${escapeHtml(result.stderr)}</code></pre>`);
        if (result.stderrTruncated) lines.push("<i>[stderr truncated]</i>");
      }
    } else {
      lines.push("<i>(no output)</i>");
    }
  } else {
    // summary mode
    const stdoutLines = result.stdout.split("\n");
    if (stdoutLines.length <= 20) {
      lines.push("<b>stdout</b> (full output attached):");
      lines.push(`<pre><code>${escapeHtml(result.stdout)}</code></pre>`);
    } else {
      const head = stdoutLines.slice(0, 10).join("\n");
      const tail = stdoutLines.slice(-10).join("\n");
      lines.push("<b>stdout</b> (first 10 / last 10 lines, full output attached):");
      lines.push(`<pre><code>${escapeHtml(head)}\n...\n${escapeHtml(tail)}</code></pre>`);
    }
    if (result.stderr) {
      const stderrLines = result.stderr.split("\n");
      if (stderrLines.length > 50) {
        const truncatedStderr = stderrLines.slice(-50).join("\n");
        lines.push("<b>stderr:</b>");
        lines.push(`<pre><code>${escapeHtml(truncatedStderr)}</code></pre>`);
        lines.push("<i>[stderr truncated, see file]</i>");
      } else {
        lines.push("<b>stderr:</b>");
        lines.push(`<pre><code>${escapeHtml(result.stderr)}</code></pre>`);
      }
    }
  }
  return lines.join("\n");
}

function buildFullOutputText(
  command: string,
  result: { stdout: string; stderr: string; exitCode: number },
): string {
  return [
    `$ ${command}`,
    `Exit: ${result.exitCode}`,
    "",
    "=== stdout ===",
    result.stdout,
    "",
    "=== stderr ===",
    result.stderr,
  ].join("\n");
}
