import { tool } from "ai";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@molf-ai/protocol";

export const writeFileTool = tool({
  description:
    "Write content to a file at the given path. " +
    "Creates the file if it doesn't exist, overwrites if it does. " +
    "Optionally creates parent directories.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file to write"),
    content: z.string().describe("Content to write to the file"),
    createDirectories: z
      .boolean()
      .describe(
        "If true, create parent directories if they don't exist (default: false)",
      )
      .optional(),
  }),
  execute: async ({ path, content, createDirectories }) => {
    try {
      if (createDirectories) {
        await mkdir(dirname(path), { recursive: true });
      }

      const bytesWritten = await Bun.write(path, content);

      return { path, bytesWritten };
    } catch (err) {
      return { error: `Failed to write file: ${errorMessage(err)}` };
    }
  },
});
