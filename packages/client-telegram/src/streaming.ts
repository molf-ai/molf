import type { Api } from "grammy";
import { markdownToTelegramHtml, stripHtml } from "./format.js";
import { MESSAGE_CHAR_LIMIT, splitIntoChunks } from "./chunking.js";
import { isParseError, isMessageNotModified } from "./telegram-errors.js";

export interface DraftStreamOptions {
  api: Api;
  chatId: number;
  throttleMs: number;
}

export interface DraftStream {
  /** Append new content delta. */
  update(fullContent: string): void;
  /** Flush any pending update immediately. Returns when the edit is complete. */
  flush(): Promise<void>;
  /** Stop the stream and return the final message ID. */
  stop(): void;
  /** Get the current draft message ID (null if not yet sent). */
  getMessageId(): number | null;
  /** Check if the stream has overflowed into a new message. */
  getOverflowMessageId(): number | null;
}

/**
 * Create an edit-in-place draft stream for a Telegram chat.
 *
 * On first content: sends a new message, stores its ID.
 * On subsequent content: edits the message with accumulated text.
 * Throttles edits to avoid Telegram rate limits.
 * If content exceeds MESSAGE_CHAR_LIMIT, starts a new message.
 */
export function createDraftStream(opts: DraftStreamOptions): DraftStream {
  const { api, chatId, throttleMs } = opts;

  let messageId: number | null = null;
  let overflowMessageId: number | null = null;
  let overflowed = false;
  let lastSentText = "";
  let pendingText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopped = false;
  // Tracks the promise of the current in-flight send/edit so flush() can await it.
  let inFlightPromise: Promise<void> | null = null;

  async function sendOrEdit(fullText: string) {
    if (stopped) return;

    // Prevent concurrent sends — if another sendOrEdit is in flight,
    // store the latest text and reschedule so it runs after the current one.
    if (inFlight) {
      pendingText = fullText;
      scheduleFlush();
      return;
    }

    let textToSend = fullText;
    if (fullText.length > MESSAGE_CHAR_LIMIT) {
      const chunks = splitIntoChunks(fullText);
      if (chunks.length > 0) {
        textToSend = chunks[chunks.length - 1];
        if (!overflowed && messageId !== null) {
          // Stop editing the current message once it fills up.
          overflowMessageId = messageId;
          messageId = null;
          lastSentText = "";
        }
        overflowed = true;
      }
    }

    if (textToSend === lastSentText) return;

    // Convert to HTML for display
    let html: string;
    let parseMode: "HTML" | undefined;
    try {
      html = markdownToTelegramHtml(textToSend);
      parseMode = "HTML";
    } catch {
      html = textToSend;
      parseMode = undefined;
    }

    if (html.length > MESSAGE_CHAR_LIMIT) {
      // Fallback to plain text so we don't exceed Telegram's limit mid-stream.
      html = textToSend;
      parseMode = undefined;
    }

    inFlight = true;
    try {
      if (messageId === null) {
        // Send new message
        const sent = await api.sendMessage(chatId, html, {
          parse_mode: parseMode,
        });
        messageId = sent.message_id;
      } else {
        // Edit existing message
        try {
          await api.editMessageText(chatId, messageId, html, {
            parse_mode: parseMode,
          });
        } catch (err: unknown) {
          // If HTML parse fails, retry with plain text
          if (isParseError(err)) {
            const plain = stripHtml(html);
            await api.editMessageText(chatId, messageId, plain);
          }
          // Ignore "message is not modified" errors
        }
      }
      lastSentText = textToSend;
    } catch (err) {
      // Log but don't throw — streaming should be resilient
      if (!isMessageNotModified(err)) {
        console.error("[telegram] Draft stream error:", err);
      }
    } finally {
      inFlight = false;
    }
  }

  /** Fire-and-forget wrapper that tracks the promise for flush(). */
  function fireSendOrEdit(text: string) {
    inFlightPromise = sendOrEdit(text).finally(() => {
      inFlightPromise = null;
    });
  }

  function scheduleFlush() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (pendingText && pendingText !== lastSentText) {
        fireSendOrEdit(pendingText);
      }
    }, throttleMs);
  }

  return {
    update(fullContent: string) {
      if (stopped) return;
      pendingText = fullContent;

      if (messageId === null && !inFlight) {
        // First content — send immediately
        fireSendOrEdit(fullContent);
      } else {
        scheduleFlush();
      }
    },

    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for any in-flight send/edit to complete first so that
      // messageId is available and we don't race with a pending send.
      if (inFlightPromise) {
        await inFlightPromise;
      }
      if (pendingText && pendingText !== lastSentText) {
        await sendOrEdit(pendingText);
      }
    },

    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    getMessageId() {
      return messageId;
    },

    getOverflowMessageId() {
      return overflowMessageId;
    },
  };
}
