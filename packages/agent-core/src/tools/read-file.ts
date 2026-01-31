import { tool } from "ai";
import { z } from "zod";

const MAX_CONTENT_LENGTH = 100_000;

export const readFileTool = tool({
  description:
    "Read the contents of a file at the given path. " +
    "Optionally specify startLine and endLine to read a specific range of lines (1-indexed).",
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
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read file: ${message}` };
    }
  },
});
