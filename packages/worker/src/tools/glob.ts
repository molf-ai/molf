import { stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, globInputSchema } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";

export { globInputSchema } from "@molf-ai/protocol";

const MAX_FILES = 100;

export async function globHandler(
  args: Record<string, unknown>,
  _ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { pattern, path } = args as { pattern: string; path?: string };

  try {
    const cwd = path ?? process.cwd();

    // Verify directory exists
    try {
      const dirStat = await stat(cwd);
      if (!dirStat.isDirectory()) {
        return { output: "", error: `Not a directory: ${cwd}` };
      }
    } catch {
      return { output: "", error: `Directory not found: ${cwd}` };
    }

    const glob = new Bun.Glob(pattern);
    const entries: { file: string; mtime: number }[] = [];
    let truncated = false;

    for await (const file of glob.scan({ cwd, dot: false })) {
      if (entries.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      try {
        const fullPath = join(cwd, file);
        const fileStat = await stat(fullPath);
        entries.push({ file, mtime: fileStat.mtimeMs });
      } catch {
        // Skip files we can't stat (e.g. broken symlinks)
        entries.push({ file, mtime: 0 });
      }
    }

    // Sort by mtime descending (newest first)
    entries.sort((a, b) => b.mtime - a.mtime);

    const files = entries.map((e) => e.file);
    const output = files.length > 0 ? files.join("\n") : "No files found";

    return {
      output,
      meta: { truncated },
    };
  } catch (err) {
    return { output: "", error: `Glob search failed: ${errorMessage(err)}` };
  }
}

/** Assembled WorkerTool for direct registration / testing. */
export const globTool: WorkerTool = {
  name: "glob",
  description: "Find files matching a glob pattern",
  inputSchema: globInputSchema,
  execute: globHandler,
  pathArgs: [{ name: "path", defaultToWorkdir: true }],
};
