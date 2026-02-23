import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const editFileInputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to edit"),
  oldString: z.string().describe("Exact text to find in the file"),
  newString: z.string().describe("Text to replace oldString with"),
  replaceAll: z
    .boolean()
    .describe("Replace all occurrences instead of requiring exactly one (default: false)")
    .optional(),
});

export const editFileDefinition: ToolDefinition = {
  name: "edit_file",
  description:
    "Edit a file by replacing exact string matches. " +
    "Provide oldString (the text to find) and newString (its replacement). " +
    "Fails if oldString is not found or matches multiple locations (unless replaceAll is true).",
  inputSchema: editFileInputSchema,
};
