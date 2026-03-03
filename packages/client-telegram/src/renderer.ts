import type { Api } from "grammy";
import { getLogger } from "@logtape/logtape";
import type { AgentEvent, AgentStatus } from "@molf-ai/protocol";
import type { SessionEventDispatcher } from "./event-dispatcher.js";
import { markdownToTelegramHtml, stripHtml, escapeHtml } from "./format.js";
import { splitIntoChunks } from "./chunking.js";
import { isParseError, isMessageNotModified } from "./telegram-errors.js";
import { createDraftStream, type DraftStream } from "./streaming.js";
import { EmbeddedBlockChunker } from "./block-chunker.js";

const logger = getLogger(["molf", "telegram"]);

export interface RendererOptions {
  api: Api;
  dispatcher: SessionEventDispatcher;
  streamingThrottleMs: number;
}

interface ChatState {
  sessionId: string;
  unsubscribe: (() => void) | null;
  draftStream: DraftStream | null;
  typingInterval: ReturnType<typeof setInterval> | null;
  agentStatus: AgentStatus;
  toolStatusMessageId: number | null;
  activeTools: Map<string, string>; // toolCallId -> toolName
  blockChunker: EmbeddedBlockChunker;
  lastPartialText: string;
  draftText: string;
}

export class Renderer {
  private api: Api;
  private dispatcher: SessionEventDispatcher;
  private throttleMs: number;
  private chats = new Map<number, ChatState>();

  constructor(opts: RendererOptions) {
    this.api = opts.api;
    this.dispatcher = opts.dispatcher;
    this.throttleMs = opts.streamingThrottleMs;
  }

  /**
   * Start listening for agent events on a session and rendering them to a chat.
   */
  startSession(chatId: number, sessionId: string) {
    // If already subscribed to this session, don't re-subscribe
    const existing = this.chats.get(chatId);
    if (existing?.sessionId === sessionId && existing.unsubscribe) return;

    // Clean up any previous subscription
    this.stopSession(chatId);

    const state: ChatState = {
      sessionId,
      unsubscribe: null,
      draftStream: null,
      typingInterval: null,
      agentStatus: "idle",
      toolStatusMessageId: null,
      activeTools: new Map(),
      blockChunker: new EmbeddedBlockChunker({
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      }),
      lastPartialText: "",
      draftText: "",
    };

    const unsub = this.dispatcher.subscribe(
      sessionId,
      (event) => this.handleEvent(chatId, event),
      (err) => logger.error("Event subscription error", { chatId, error: err }),
    );

    state.unsubscribe = unsub;
    this.chats.set(chatId, state);
  }

  /**
   * Stop listening for events on a chat.
   */
  stopSession(chatId: number) {
    const state = this.chats.get(chatId);
    if (!state) return;

    state.unsubscribe?.();
    state.draftStream?.stop();
    this.stopTypingIndicator(state);
    this.chats.delete(chatId);
  }

  /**
   * Get the agent status for a chat.
   */
  getAgentStatus(chatId: number): string {
    return this.chats.get(chatId)?.agentStatus ?? "idle";
  }

  /**
   * Clean up all sessions.
   */
  cleanup() {
    for (const chatId of this.chats.keys()) {
      this.stopSession(chatId);
    }
  }

  private async handleEvent(chatId: number, event: AgentEvent) {
    const state = this.chats.get(chatId);
    if (!state) return;

    switch (event.type) {
      case "status_change":
        state.agentStatus = event.status;
        if (event.status === "streaming") {
          this.startTypingIndicator(chatId, state);
        } else if (event.status === "idle" || event.status === "error" || event.status === "aborted") {
          this.stopTypingIndicator(state);
        }
        break;

      case "content_delta":
        this.handleContentDelta(chatId, state, event.content);
        break;

      case "tool_call_start":
        await this.handleToolCallStart(chatId, state, event.toolCallId, event.toolName);
        break;

      case "tool_call_end":
        await this.handleToolCallEnd(chatId, state, event.toolCallId, event.toolName, event.result);
        break;

      case "turn_complete":
        await this.handleTurnComplete(chatId, state, event.message.content);
        break;

      case "error":
        this.stopTypingIndicator(state);
        state.draftStream?.stop();
        state.draftStream = null;
        state.blockChunker.reset();
        state.lastPartialText = "";
        state.draftText = "";
        await this.sendSafe(chatId,
          `Something went wrong: ${event.message}\n\nTry /new to start a fresh session.`,
        );
        break;

      case "tool_approval_required":
        // Handled by approval.ts — this renderer doesn't handle it directly.
        // The approval module listens for this event type.
        break;

      case "subagent_event":
        // Subagent events are informational for TUI. Approvals are extracted
        // by the approval module directly. Nothing to render here.
        break;
    }
  }

  private handleContentDelta(chatId: number, state: ChatState, fullContent: string) {
    if (!state.draftStream) {
      state.draftStream = createDraftStream({
        api: this.api,
        chatId,
        throttleMs: this.throttleMs,
      });
    }
    if (fullContent === state.lastPartialText) return;

    let delta: string;
    if (fullContent.startsWith(state.lastPartialText)) {
      delta = fullContent.slice(state.lastPartialText.length);
    } else {
      // Non-monotonic stream — reset
      state.blockChunker.reset();
      state.draftText = "";
      delta = fullContent;
    }
    state.lastPartialText = fullContent;
    if (!delta) return;

    state.blockChunker.append(delta);
    state.blockChunker.drain({
      force: false,
      emit: (chunk) => {
        state.draftText += chunk;
        state.draftStream!.update(state.draftText);
      },
    });
  }

  private async handleToolCallStart(
    chatId: number,
    state: ChatState,
    toolCallId: string,
    toolName: string,
  ) {
    state.activeTools.set(toolCallId, toolName);
    await this.updateToolStatus(chatId, state);
  }

  private async handleToolCallEnd(
    chatId: number,
    state: ChatState,
    toolCallId: string,
    toolName: string,
    result: string,
  ) {
    state.activeTools.delete(toolCallId);

    // Update the status message
    const resultIndicator = result.includes("error") ? "Failed" : "Completed";
    const statusText = `${resultIndicator}: <code>${escapeHtml(toolName)}</code>`;

    if (state.toolStatusMessageId) {
      try {
        // Build combined status: completed tool + any still running
        const lines = [statusText];
        for (const [, name] of state.activeTools) {
          lines.push(`Running: <code>${escapeHtml(name)}</code>...`);
        }
        await this.api.editMessageText(
          chatId,
          state.toolStatusMessageId,
          lines.join("\n"),
          { parse_mode: "HTML" },
        );
      } catch {
        // Ignore edit failures
      }
    }

    if (state.activeTools.size === 0) {
      state.toolStatusMessageId = null;
    }
  }

  private async updateToolStatus(chatId: number, state: ChatState) {
    const lines: string[] = [];
    for (const [, name] of state.activeTools) {
      lines.push(`Running: <code>${escapeHtml(name)}</code>...`);
    }
    const text = lines.join("\n");

    if (state.toolStatusMessageId) {
      try {
        await this.api.editMessageText(chatId, state.toolStatusMessageId, text, {
          parse_mode: "HTML",
        });
      } catch {
        // If edit fails, send new message
        state.toolStatusMessageId = null;
      }
    }

    if (!state.toolStatusMessageId) {
      try {
        const sent = await this.api.sendMessage(chatId, text, { parse_mode: "HTML" });
        state.toolStatusMessageId = sent.message_id;
      } catch (err) {
        logger.warn("Failed to send tool status", { chatId, error: err });
      }
    }
  }

  private async handleTurnComplete(chatId: number, state: ChatState, content: string) {
    this.stopTypingIndicator(state);

    // Force-flush any remaining buffered content from the chunker
    if (state.blockChunker.hasBuffered()) {
      state.blockChunker.drain({
        force: true,
        emit: (chunk) => { state.draftText += chunk; },
      });
      state.blockChunker.reset();
      if (state.draftText && state.draftStream) {
        state.draftStream.update(state.draftText);
      }
    }

    // Flush and capture the draft stream's message ID
    let draftMessageId: number | null = null;
    if (state.draftStream) {
      await state.draftStream.flush();
      draftMessageId = state.draftStream.getMessageId();
      state.draftStream.stop();
      state.draftStream = null;
    }

    // Reset chunker state
    state.lastPartialText = "";
    state.draftText = "";

    const chunks = splitIntoChunks(content);
    if (chunks.length === 0) return;

    // First chunk: edit the draft message if it exists, otherwise send new
    if (draftMessageId) {
      const edited = await this.editFormatted(chatId, draftMessageId, chunks[0]);
      if (!edited) {
        // Edit failed — send as new message instead
        await this.sendFormatted(chatId, chunks[0]);
      }
    } else {
      await this.sendFormatted(chatId, chunks[0]);
    }

    // Subsequent chunks: send as new messages
    for (let i = 1; i < chunks.length; i++) {
      await sleep(100);
      await this.sendFormatted(chatId, chunks[i]);
    }
  }

  private async editFormatted(chatId: number, messageId: number, text: string): Promise<boolean> {
    try {
      const html = markdownToTelegramHtml(text);
      await this.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
      return true;
    } catch (err: unknown) {
      // "message is not modified" means content already matches — not a real failure
      if (isMessageNotModified(err)) return true;
      if (isParseError(err)) {
        try {
          await this.api.editMessageText(chatId, messageId, text);
          return true;
        } catch (retryErr: unknown) {
          return isMessageNotModified(retryErr);
        }
      }
      return false;
    }
  }

  private async sendFormatted(chatId: number, text: string) {
    try {
      const html = markdownToTelegramHtml(text);
      await this.api.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch (err: unknown) {
      if (isParseError(err)) {
        // Fallback to plain text
        await this.api.sendMessage(chatId, stripHtml(text));
      } else {
        throw err;
      }
    }
  }

  private async sendSafe(chatId: number, text: string) {
    try {
      await this.api.sendMessage(chatId, text);
    } catch (err) {
      logger.error("Failed to send message", { chatId, error: err });
    }
  }

  private startTypingIndicator(chatId: number, state: ChatState) {
    if (state.typingInterval) return;

    // Send immediately
    this.api.sendChatAction(chatId, "typing").catch(() => {});

    // Repeat every 5 seconds, with a 5-minute safety limit
    const startedAt = Date.now();
    state.typingInterval = setInterval(() => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        this.stopTypingIndicator(state);
        return;
      }
      this.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 5000);
  }

  private stopTypingIndicator(state: ChatState) {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
