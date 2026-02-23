import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext } from "@molf-ai/protocol";

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

    const bytesWritten = await Bun.write(path, content);

    return { output: `Wrote ${bytesWritten} bytes to ${path}` };
  } catch (err) {
    return { output: "", error: `Failed to write file: ${errorMessage(err)}` };
  }
}
