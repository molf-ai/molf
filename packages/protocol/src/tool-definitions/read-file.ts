import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const readFileInputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to read"),
  startLine: z
    .number()
    .describe("First line to read (1-indexed, positive integer, inclusive)")
    .optional(),
  endLine: z
    .number()
    .describe("Last line to read (1-indexed, positive integer, inclusive)")
    .optional(),
});

export const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. " +
    "Optionally specify startLine and endLine to read a specific range of lines (1-indexed). " +
    "For binary files (images, PDFs, audio), returns the file as base64 media.",
  inputSchema: readFileInputSchema,
};
