import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const writeFileInputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to write"),
  content: z.string().describe("Content to write to the file"),
  createDirectories: z
    .boolean()
    .describe(
      "If true, create parent directories if they don't exist (default: false)",
    )
    .optional(),
});

export const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file at the given path. " +
    "Creates the file if it doesn't exist, overwrites if it does. " +
    "Optionally creates parent directories.",
  inputSchema: writeFileInputSchema,
};
