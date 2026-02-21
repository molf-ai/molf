/**
 * Split long messages respecting Telegram's 4096 character wire limit.
 * We use 4000 as the effective limit to account for HTML entity expansion.
 *
 * Splitting priorities:
 *   1. Never split inside a fenced code block (``` ... ```)
 *   2. Double newline (paragraph break)
 *   3. Single newline
 *   4. Sentence end (". ")
 *   5. Hard cut at limit as last resort
 */

export const MESSAGE_CHAR_LIMIT = 4000;

export interface ChunkOptions {
  limit?: number;
}

/**
 * Split text into chunks that respect the character limit.
 * Markdown-aware: never splits inside fenced code blocks.
 */
export function splitIntoChunks(
  text: string,
  opts?: ChunkOptions,
): string[] {
  const limit = opts?.limit ?? MESSAGE_CHAR_LIMIT;

  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findBestCutPoint(remaining, limit);
    chunks.push(remaining.slice(0, cutPoint).trimEnd());
    remaining = remaining.slice(cutPoint).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

function findBestCutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);

  // Priority 1: Don't split inside a code fence.
  // Find if we're inside an unclosed code fence at the limit point.
  const fencePositions = findFencePositions(window);
  if (fencePositions.insideFence) {
    // We're inside a code fence at the cut point.
    // Try to cut before the opening fence.
    if (fencePositions.lastOpenFence > 0) {
      const beforeFence = fencePositions.lastOpenFence;
      // Look for a good break before the fence
      const breakBefore = findBreakBefore(text, beforeFence);
      if (breakBefore > 0) return breakBefore;
      // Cut right before the fence
      return beforeFence;
    }
    // The code fence starts at the very beginning — cut after the closing fence
    // if it fits within the limit
    const closingFence = text.indexOf("```", fencePositions.lastOpenFence + 3);
    if (closingFence !== -1) {
      const endOfFence = text.indexOf("\n", closingFence);
      const afterFence = endOfFence !== -1 ? endOfFence + 1 : closingFence + 3;
      if (afterFence <= limit) {
        return afterFence;
      }
    }
  }

  // Priority 2: Double newline (paragraph break)
  const doubleNewline = window.lastIndexOf("\n\n");
  if (doubleNewline > limit * 0.3) return doubleNewline + 2;

  // Priority 3: Single newline
  const singleNewline = window.lastIndexOf("\n");
  if (singleNewline > limit * 0.3) return singleNewline + 1;

  // Priority 4: Sentence end
  const sentenceEnd = window.lastIndexOf(". ");
  if (sentenceEnd > limit * 0.3) return sentenceEnd + 2;

  // Priority 5: Hard cut
  return limit;
}

function findBreakBefore(text: string, pos: number): number {
  const window = text.slice(0, pos);

  const doubleNewline = window.lastIndexOf("\n\n");
  if (doubleNewline > pos * 0.3) return doubleNewline + 2;

  const singleNewline = window.lastIndexOf("\n");
  if (singleNewline > pos * 0.3) return singleNewline + 1;

  return 0;
}

interface FenceInfo {
  insideFence: boolean;
  lastOpenFence: number;
}

function findFencePositions(text: string): FenceInfo {
  let inside = false;
  let lastOpen = -1;
  let idx = 0;

  while (idx < text.length) {
    const fenceStart = text.indexOf("```", idx);
    if (fenceStart === -1) break;

    if (!inside) {
      inside = true;
      lastOpen = fenceStart;
      // Skip past the fence marker and language tag
      const lineEnd = text.indexOf("\n", fenceStart);
      idx = lineEnd !== -1 ? lineEnd + 1 : fenceStart + 3;
    } else {
      inside = false;
      idx = fenceStart + 3;
      // Skip past closing fence line
      const lineEnd = text.indexOf("\n", fenceStart);
      idx = lineEnd !== -1 ? lineEnd + 1 : fenceStart + 3;
    }
  }

  return { insideFence: inside, lastOpenFence: lastOpen };
}
