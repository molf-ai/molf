import { extname } from "path";
import { errorMessage, readFileInputSchema } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";
import { discoverNestedInstructions } from "../nested-instructions.js";

export { readFileInputSchema } from "@molf-ai/protocol";

const MAX_CONTENT_LENGTH = 100_000;
const MAX_BINARY_BYTES = 15 * 1024 * 1024; // 15MB
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
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      return { output: "", error: `File not found: ${path}` };
    }

    const ext = extname(path).toLowerCase();
    const mimeType = BINARY_EXTENSIONS[ext];

    if (mimeType) {
      const size = file.size;
      if (size > MAX_BINARY_BYTES) {
        return { output: "", error: `File too large for binary read: ${size} bytes (max ${MAX_BINARY_BYTES})` };
      }
      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return {
        output: `[Binary file: ${path}, ${mimeType}, ${size} bytes]`,
        meta: { truncated: false },
        attachments: [{ mimeType, data: base64, path, size }],
      };
    }

    if (OPAQUE_BINARY_EXTENSIONS.has(ext)) {
      return { output: "", error: `Cannot read binary file: ${path} (${ext}, ${file.size} bytes)` };
    }

    const sample = new Uint8Array(await file.slice(0, BINARY_SAMPLE_BYTES).arrayBuffer());
    if (sample.length > 0 && isBinaryContent(sample)) {
      return { output: "", error: `Cannot read binary file: ${path} (${ext || "unknown"}, ${file.size} bytes)` };
    }

    const raw = await file.text();
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
