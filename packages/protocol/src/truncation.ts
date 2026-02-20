// --- Tool output truncation utility (shared between worker and server) ---

export const TRUNCATION_MAX_LINES = 2000;
export const TRUNCATION_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  content: string;
  truncated: boolean;
  removedLines?: number;
}

/**
 * Truncate text if it exceeds line or byte thresholds.
 * Cuts at whichever limit is hit first. Always truncates at a line boundary.
 */
export function truncateOutput(
  text: string,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult {
  const maxLines = options?.maxLines ?? TRUNCATION_MAX_LINES;
  const maxBytes = options?.maxBytes ?? TRUNCATION_MAX_BYTES;

  const byteLength = Buffer.byteLength(text, "utf-8");

  if (byteLength <= maxBytes) {
    // Fast path: if within byte budget, just check line count
    const lines = text.split("\n");
    if (lines.length <= maxLines) {
      return { content: text, truncated: false };
    }
    const truncated = lines.slice(0, maxLines).join("\n");
    return {
      content: truncated,
      truncated: true,
      removedLines: lines.length - maxLines,
    };
  }

  // Byte limit hit — find the last full line within budget
  const lines = text.split("\n");
  let currentBytes = 0;
  let lineCount = 0;

  for (const line of lines) {
    // +1 for the newline character (except potentially last line, but safe to include)
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
    if (currentBytes + lineBytes > maxBytes || lineCount >= maxLines) {
      break;
    }
    currentBytes += lineBytes;
    lineCount++;
  }

  // Single oversized line: byte-truncate to avoid sending megabytes to LLM
  if (lineCount === 0) {
    const byteSliced = Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8");
    // Remove potentially broken trailing character from subarray slice
    const clean = byteSliced.replace(/\uFFFD$/, "");
    return {
      content: clean,
      truncated: true,
      removedLines: lines.length - 1,
    };
  }

  const truncated = lines.slice(0, lineCount).join("\n");
  return {
    content: truncated,
    truncated: true,
    removedLines: lines.length - lineCount,
  };
}
