import type { SessionMessage } from "./types.js";

// --- Constants ---

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const IMAGE_CHAR_ESTIMATE = 8_000;
export const KEEP_LAST_ASSISTANTS = 3;
export const SOFT_TRIM_RATIO = 0.3;
export const HARD_CLEAR_RATIO = 0.5;
export const SOFT_TRIM_MAX_CHARS = 4_000;
export const SOFT_TRIM_HEAD_CHARS = 1_500;
export const SOFT_TRIM_TAIL_CHARS = 1_500;
export const HARD_CLEAR_PLACEHOLDER = "[Old tool result content cleared]";
export const MIN_PRUNABLE_TOOL_CHARS = 50_000;

// --- Helpers ---

export function estimateMessageChars(msg: SessionMessage): number {
  let chars = msg.content.length;
  if (msg.attachments) {
    chars += msg.attachments.length * IMAGE_CHAR_ESTIMATE;
  }
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      try {
        chars += JSON.stringify(tc.args).length;
      } catch {
        chars += 128;
      }
    }
  }
  return chars;
}

export function estimateContextChars(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageChars(msg);
  }
  return total;
}

export function findAssistantCutoffIndex(
  messages: readonly SessionMessage[],
  keepLastAssistants: number,
): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      count++;
      if (count === keepLastAssistants) return i;
    }
  }
  return null;
}

export function findFirstUserIndex(messages: readonly SessionMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return null;
}

export function softTrimContent(
  content: string,
  headChars: number,
  tailChars: number,
): string {
  if (content.length <= headChars + tailChars) return content;
  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  return (
    head +
    "\n...\n" +
    tail +
    `\n\n[Tool result trimmed: kept first ${headChars} and last ${tailChars} chars of ${content.length} chars.]`
  );
}

// --- Main pruning function ---

export function pruneContext(
  messages: readonly SessionMessage[],
  contextWindowTokens: number,
  aggressive?: boolean,
): SessionMessage[] {
  if (contextWindowTokens <= 0) return [...messages];

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  let totalChars = estimateContextChars(messages);
  let ratio = totalChars / charWindow;

  const softTrimRatio = aggressive ? 0 : SOFT_TRIM_RATIO;
  const hardClearRatio = aggressive ? 0 : HARD_CLEAR_RATIO;
  const minPrunableToolChars = aggressive ? 0 : MIN_PRUNABLE_TOOL_CHARS;

  if (ratio < softTrimRatio) return [...messages];

  const cutoffIndex = findAssistantCutoffIndex(messages, KEEP_LAST_ASSISTANTS);
  if (cutoffIndex === null) return [...messages];

  const pruneStartIndex = findFirstUserIndex(messages);
  if (pruneStartIndex === null) return [...messages];

  // Collect prunable tool indexes in [pruneStartIndex, cutoffIndex)
  const prunableIndexes: number[] = [];
  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    if (messages[i].role === "tool" && messages[i].toolName !== "skill") {
      prunableIndexes.push(i);
    }
  }

  // Shallow copy the array — we'll replace individual entries as needed
  const result: SessionMessage[] = [...messages];

  // PASS 1 — soft-trim
  for (const idx of prunableIndexes) {
    if (ratio < softTrimRatio) break;
    const msg = result[idx];
    if (msg.content.length > SOFT_TRIM_MAX_CHARS) {
      const trimmed = softTrimContent(msg.content, SOFT_TRIM_HEAD_CHARS, SOFT_TRIM_TAIL_CHARS);
      const saved = msg.content.length - trimmed.length;
      result[idx] = { ...msg, content: trimmed };
      totalChars -= saved;
      ratio = totalChars / charWindow;
    }
  }

  // PASS 2 — hard-clear
  if (ratio >= hardClearRatio) {
    let totalPrunableChars = 0;
    for (const idx of prunableIndexes) {
      totalPrunableChars += result[idx].content.length;
    }
    if (totalPrunableChars >= minPrunableToolChars) {
      for (const idx of prunableIndexes) {
        if (ratio < hardClearRatio) break;
        const msg = result[idx];
        const saved = msg.content.length - HARD_CLEAR_PLACEHOLDER.length;
        if (saved > 0) {
          result[idx] = { ...msg, content: HARD_CLEAR_PLACEHOLDER };
          totalChars -= saved;
          ratio = totalChars / charWindow;
        }
      }
    }
  }

  return result;
}

// --- Error detection ---

const CONTEXT_LENGTH_PATTERNS = [
  "resource_exhausted",
  "context_length_exceeded",
  "maximum context length",
  "too many tokens",
  "request too large",
  "request_too_large",
  "request size exceeds",
  "prompt is too long",
  "exceeds model context window",
  "content_too_large",
  "token limit",
  "context window",
];

export function isContextLengthError(err: unknown): boolean {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === "string") {
    message = err;
  } else {
    return false;
  }
  const lower = message.toLowerCase();
  return CONTEXT_LENGTH_PATTERNS.some((pattern) => lower.includes(pattern));
}
