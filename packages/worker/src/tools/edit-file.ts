import { readFile, writeFile, stat } from "node:fs/promises";
import { errorMessage, editFileInputSchema } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";

export { editFileInputSchema } from "@molf-ai/protocol";

export async function editFileHandler(
  args: Record<string, unknown>,
  _ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { path, oldString, newString, replaceAll } = args as {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  };

  try {
    if (oldString.length === 0) {
      return { output: "", error: "oldString must not be empty" };
    }

    if (oldString === newString) {
      return { output: "", error: "oldString and newString are identical; no change needed" };
    }

    try {
      await stat(path);
    } catch {
      return { output: "", error: `File not found: ${path}` };
    }

    const content = await readFile(path, "utf-8");

    // Count occurrences via indexOf loop
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
    }

    if (count === 0) {
      return { output: "", error: "oldString not found in file" };
    }

    if (count > 1 && !replaceAll) {
      return {
        output: "",
        error: `oldString found ${count} times in file. Use replaceAll to replace all occurrences, or provide more context to match a unique location.`,
      };
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);

    await writeFile(path, updated, "utf-8");

    const replacements = replaceAll ? count : 1;
    return { output: `Replaced ${replacements} occurrence(s) in ${path}` };
  } catch (err) {
    return { output: "", error: `Failed to edit file: ${errorMessage(err)}` };
  }
}

/** Assembled WorkerTool for direct registration / testing. */
export const editFileTool: WorkerTool = {
  name: "edit_file",
  description: "Edit a file by replacing text",
  inputSchema: editFileInputSchema,
  execute: editFileHandler,
  pathArgs: [{ name: "path" }],
};
