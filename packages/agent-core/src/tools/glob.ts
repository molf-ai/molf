import { tool } from "ai";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILES = 100;

export const globTool = tool({
  description:
    "Find files matching a glob pattern. " +
    "Returns matching file paths sorted by modification time (newest first). " +
    "Use pattern like '**/*.ts' for recursive TypeScript file search.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.js')"),
    path: z
      .string()
      .describe("Directory to search in (default: current working directory)")
      .optional(),
  }),
  execute: async ({ pattern, path }) => {
    try {
      const cwd = path ?? process.cwd();

      // Verify directory exists
      try {
        const dirStat = await stat(cwd);
        if (!dirStat.isDirectory()) {
          return { error: `Not a directory: ${cwd}` };
        }
      } catch {
        return { error: `Directory not found: ${cwd}` };
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

      return {
        files: entries.map((e) => e.file),
        count: entries.length,
        truncated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Glob search failed: ${message}` };
    }
  },
});
