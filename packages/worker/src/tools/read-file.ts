import { tool } from "ai";
import { z } from "zod";
import { extname } from "path";
import { errorMessage } from "@molf-ai/protocol";

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

export const readFileTool = tool({
  description:
    "Read the contents of a file at the given path. " +
    "Optionally specify startLine and endLine to read a specific range of lines (1-indexed). " +
    "For binary files (images, PDFs, audio), returns the file as base64 media.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file to read"),
    startLine: z
      .number()
      .describe("First line to read (1-indexed, positive integer, inclusive)")
      .optional(),
    endLine: z
      .number()
      .describe("Last line to read (1-indexed, positive integer, inclusive)")
      .optional(),
  }),
  execute: async ({ path, startLine, endLine }) => {
    try {
      const file = Bun.file(path);
      const exists = await file.exists();
      if (!exists) {
        return { error: `File not found: ${path}` };
      }

      const ext = extname(path).toLowerCase();
      const mimeType = BINARY_EXTENSIONS[ext];

      if (mimeType) {
        const size = file.size;
        if (size > MAX_BINARY_BYTES) {
          return { error: `File too large for binary read: ${size} bytes (max ${MAX_BINARY_BYTES})` };
        }
        const buffer = await file.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        return { type: "binary" as const, data: base64, mimeType, path, size };
      }

      if (OPAQUE_BINARY_EXTENSIONS.has(ext)) {
        return { error: `Cannot read binary file: ${path} (${ext}, ${file.size} bytes)` };
      }

      const sample = new Uint8Array(await file.slice(0, BINARY_SAMPLE_BYTES).arrayBuffer());
      if (sample.length > 0 && isBinaryContent(sample)) {
        return { error: `Cannot read binary file: ${path} (${ext || "unknown"}, ${file.size} bytes)` };
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

      return { content, totalLines, truncated };
    } catch (err) {
      return { error: `Failed to read file: ${errorMessage(err)}` };
    }
  },
});
