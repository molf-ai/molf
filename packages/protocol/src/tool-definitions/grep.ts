import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const grepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z
    .string()
    .describe("File or directory to search in (default: current working directory)")
    .optional(),
  include: z
    .string()
    .describe("File glob filter (e.g. '*.ts', '*.{js,jsx}')")
    .optional(),
});

export const grepDefinition: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using regex patterns. " +
    "Uses ripgrep (rg) if available, falls back to system grep. " +
    "Returns matching lines with file path and line number, sorted by file modification time.",
  inputSchema: grepInputSchema,
};
