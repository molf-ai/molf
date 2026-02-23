import { errorMessage } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext } from "@molf-ai/protocol";

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

    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      return { output: "", error: `File not found: ${path}` };
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

    await Bun.write(path, updated);

    const replacements = replaceAll ? count : 1;
    return { output: `Replaced ${replacements} occurrence(s) in ${path}` };
  } catch (err) {
    return { output: "", error: `Failed to edit file: ${errorMessage(err)}` };
  }
}
