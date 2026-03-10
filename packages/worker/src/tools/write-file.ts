import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage, writeFileInputSchema } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";

export { writeFileInputSchema } from "@molf-ai/protocol";

export async function writeFileHandler(
  args: Record<string, unknown>,
  _ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { path, content, createDirectories } = args as {
    path: string;
    content: string;
    createDirectories?: boolean;
  };

  try {
    if (createDirectories) {
      await mkdir(dirname(path), { recursive: true });
    }

    await writeFile(path, content, "utf-8");
    const bytesWritten = Buffer.byteLength(content, "utf-8");

    return { output: `Wrote ${bytesWritten} bytes to ${path}` };
  } catch (err) {
    return { output: "", error: `Failed to write file: ${errorMessage(err)}` };
  }
}

/** Assembled WorkerTool for direct registration / testing. */
export const writeFileTool: WorkerTool = {
  name: "write_file",
  description: "Write content to a file",
  inputSchema: writeFileInputSchema,
  execute: writeFileHandler,
  pathArgs: [{ name: "path" }],
};
