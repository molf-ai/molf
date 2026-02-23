import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const globInputSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.js')"),
  path: z
    .string()
    .describe("Directory to search in (default: current working directory)")
    .optional(),
});

export const globDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Find files matching a glob pattern. " +
    "Returns matching file paths sorted by modification time (newest first). " +
    "Use pattern like '**/*.ts' for recursive TypeScript file search.",
  inputSchema: globInputSchema,
};
