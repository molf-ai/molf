import { resolve } from "path";
import { mkdir, writeFile } from "fs/promises";
import { getLogger } from "@logtape/logtape";
import { truncateOutput } from "@molf-ai/protocol";

const logger = getLogger(["molf", "plugin", "builtin-tools", "truncation"]);

const OUTPUT_DIR = ".molf/tool-output";
const SAFE_ID_RE = /^[a-zA-Z0-9_\-]+$/;

/** Validate that an ID is safe to use in file paths (no path traversal). */
export function isSafeToolCallId(id: string): boolean {
  return SAFE_ID_RE.test(id) && id.length > 0 && id.length <= 256;
}

export interface TruncateAndStoreResult {
  content: string;
  truncated: boolean;
  outputId?: string;
  outputPath?: string;
}

/**
 * Truncate text if it exceeds thresholds, saving full output to disk.
 * Returns truncated preview with a hint pointing to the full output file.
 */
export async function truncateAndStore(
  text: string,
  toolCallId: string,
  workdir: string,
): Promise<TruncateAndStoreResult> {
  const result = truncateOutput(text);
  if (!result.truncated) {
    return { content: text, truncated: false };
  }

  // Skip file storage if toolCallId contains unsafe characters
  if (!isSafeToolCallId(toolCallId)) {
    logger.warn("Unsafe toolCallId for file storage", { toolCallId });
    return {
      content: result.content + `\n\n...${result.removedLines} lines truncated...`,
      truncated: true,
    };
  }

  const outputDir = resolve(workdir, OUTPUT_DIR);
  const outputPath = resolve(outputDir, `${toolCallId}.txt`);

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, text, "utf-8");
  } catch (err) {
    logger.warn("Failed to save output", { outputPath, error: err });
    return {
      content: result.content + `\n\n...${result.removedLines} lines truncated...`,
      truncated: true,
    };
  }

  return {
    content:
      result.content +
      `\n\n...${result.removedLines} lines truncated...\n\n` +
      `Output was truncated. Full output saved to: ${outputPath}\n` +
      `Use the read_file tool with offset and limit parameters to view specific sections, or use grep to search the full content.`,
    truncated: true,
    outputId: toolCallId,
    outputPath,
  };
}
