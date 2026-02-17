import { tool } from "ai";
import { z } from "zod";
import { errorMessage } from "@molf-ai/protocol";

export const editFileTool = tool({
  description:
    "Edit a file by replacing exact string matches. " +
    "Provide oldString (the text to find) and newString (its replacement). " +
    "Fails if oldString is not found or matches multiple locations (unless replaceAll is true).",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file to edit"),
    oldString: z.string().describe("Exact text to find in the file"),
    newString: z.string().describe("Text to replace oldString with"),
    replaceAll: z
      .boolean()
      .describe("Replace all occurrences instead of requiring exactly one (default: false)")
      .optional(),
  }),
  execute: async ({ path, oldString, newString, replaceAll }) => {
    try {
      if (oldString.length === 0) {
        return { error: "oldString must not be empty" };
      }

      if (oldString === newString) {
        return { error: "oldString and newString are identical; no change needed" };
      }

      const file = Bun.file(path);
      const exists = await file.exists();
      if (!exists) {
        return { error: `File not found: ${path}` };
      }

      const content = await file.text();

      // Count occurrences via indexOf loop
      let count = 0;
      let idx = 0;
      while ((idx = content.indexOf(oldString, idx)) !== -1) {
        count++;
        idx += oldString.length;
      }

      if (count === 0) {
        return { error: "oldString not found in file" };
      }

      if (count > 1 && !replaceAll) {
        return {
          error: `oldString found ${count} times in file. Use replaceAll to replace all occurrences, or provide more context to match a unique location.`,
        };
      }

      const updated = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);

      await Bun.write(path, updated);

      return { path, replacements: replaceAll ? count : 1 };
    } catch (err) {
      return { error: `Failed to edit file: ${errorMessage(err)}` };
    }
  },
});
