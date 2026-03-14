import { extname } from "path";
import { readFile, stat, open } from "node:fs/promises";
import { getFile } from "@mjackson/lazy-file/fs";
import { errorMessage, readFileInputSchema, MAX_ATTACHMENT_BYTES } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";
import { discoverNestedInstructions } from "../nested-instructions.js";

export { readFileInputSchema } from "@molf-ai/protocol";

const MAX_CONTENT_LENGTH = 100_000;
const BINARY_SAMPLE_BYTES = 4096;
const BINARY_THRESHOLD = 0.3; // >30% non-printable → binary

const OPAQUE_BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz", ".zst",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".o", ".a", ".lib", ".obj", ".class", ".pyc", ".pyo",
  ".wasm", ".jar", ".war",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",
  ".sqlite", ".db",
]);

const BINARY_EXTENSIONS: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  // PDFs
  ".pdf": "application/pdf",
  // Audio
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

function isBinaryContent(bytes: Uint8Array): boolean {
  let nonPrintable = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++;
  }
  return nonPrintable / bytes.length > BINARY_THRESHOLD;
}

export async function readFileHandler(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { path, startLine, endLine } = args as {
    path: string;
    startLine?: number;
    endLine?: number;
  };

  try {
    let fileSize: number;
    try {
      const fileStat = await stat(path);
      fileSize = fileStat.size;
    } catch {
      return { output: "", error: `File not found: ${path}` };
    }

    const ext = extname(path).toLowerCase();
    const mimeType = BINARY_EXTENSIONS[ext];

    if (mimeType) {
      if (fileSize > MAX_ATTACHMENT_BYTES) {
        return { output: "", error: `File too large for binary read: ${fileSize} bytes (max ${MAX_ATTACHMENT_BYTES})` };
      }
      const file = getFile(path);  // zero-copy — no I/O until oRPC serializes
      return {
        output: `[Binary file: ${path}, ${mimeType}, ${fileSize} bytes]`,
        meta: { truncated: false },
        attachments: [{ mimeType, data: file, path, size: fileSize }],
      };
    }

    if (OPAQUE_BINARY_EXTENSIONS.has(ext)) {
      return { output: "", error: `Cannot read binary file: ${path} (${ext}, ${fileSize} bytes)` };
    }

    // Read a sample to detect binary content without reading the entire file
    const sampleSize = Math.min(BINARY_SAMPLE_BYTES, fileSize);
    if (sampleSize > 0) {
      const fh = await open(path, "r");
      const sample = Buffer.alloc(sampleSize);
      await fh.read(sample, 0, sampleSize, 0);
      await fh.close();
      if (isBinaryContent(new Uint8Array(sample.buffer, sample.byteOffset, sample.byteLength))) {
        return { output: "", error: `Cannot read binary file: ${path} (${ext || "unknown"}, ${fileSize} bytes)` };
      }
    }

    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    const totalLines = lines.length;

    let selectedLines = lines;
    if (startLine !== undefined || endLine !== undefined) {
      const start = (startLine ?? 1) - 1;
      const end = endLine ?? totalLines;
      selectedLines = lines.slice(start, end);
    }

    let content = selectedLines.join("\n");
    let truncated = false;

    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH);
      truncated = true;
    }

    const output = `Content of ${path} (${totalLines} lines):\n${content}`;

    // Discover nested instruction files (AGENTS.md / CLAUDE.md in parent dirs)
    let instructionFiles: Array<{ path: string; content: string }> | undefined;
    if (ctx.workdir) {
      const found = discoverNestedInstructions(path, ctx.workdir);
      if (found.length > 0) instructionFiles = found;
    }

    return {
      output,
      meta: { truncated, instructionFiles },
    };
  } catch (err) {
    return { output: "", error: `Failed to read file: ${errorMessage(err)}` };
  }
}

/** Assembled WorkerTool for direct registration / testing. */
export const readFileTool: WorkerTool = {
  name: "read_file",
  description: "Read the contents of a file",
  inputSchema: readFileInputSchema,
  execute: readFileHandler,
  pathArgs: [{ name: "path" }],
};
