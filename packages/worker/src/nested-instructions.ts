import { existsSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Discover nested instruction files between a file's directory and workdir.
 * Walks from dirname(filePath) up to workdir (exclusive), checking
 * AGENTS.md first, then CLAUDE.md per directory.
 */
export function discoverNestedInstructions(
  filePath: string,
  workdir: string,
): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const resolvedWorkdir = resolve(workdir);
  let dir = dirname(resolve(filePath));

  // Walk up to workdir (exclusive)
  while (dir.startsWith(resolvedWorkdir + "/") && dir !== resolvedWorkdir) {
    for (const filename of INSTRUCTION_FILES) {
      const filepath = resolve(dir, filename);
      if (!existsSync(filepath)) continue;
      try {
        const content = readFileSync(filepath, "utf-8");
        results.push({ path: relative(resolvedWorkdir, filepath), content });
        break; // Only one per directory: AGENTS.md wins over CLAUDE.md
      } catch {
        continue;
      }
    }
    dir = dirname(dir);
  }

  return results;
}
