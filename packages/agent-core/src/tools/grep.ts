import { tool } from "ai";
import { z } from "zod";
import { stat } from "node:fs/promises";

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 500;
const GREP_TIMEOUT_MS = 15_000;

let cachedRgPath: string | null | undefined;

function getRipgrepPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  cachedRgPath = Bun.which("rg");
  return cachedRgPath;
}

/** Reset cached ripgrep path (for testing). */
export function resetRgCache(): void {
  cachedRgPath = undefined;
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function truncateLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return text.slice(0, MAX_LINE_LENGTH);
}

async function runRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<GrepMatch[]> {
  const args = [
    getRipgrepPath()!,
    "-nH",
    "--hidden",
    "--no-messages",
    "--field-match-separator=|",
    "--regexp",
    pattern,
  ];
  if (include) {
    args.push("--glob", include);
  }
  args.push(searchPath);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), GREP_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timeout);
  }

  const output = await new Response(proc.stdout).text();
  const matches: GrepMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    if (matches.length >= MAX_MATCHES) break;

    // Format: filePath|lineNum|lineText
    const firstPipe = line.indexOf("|");
    if (firstPipe === -1) continue;
    const secondPipe = line.indexOf("|", firstPipe + 1);
    if (secondPipe === -1) continue;

    const file = line.slice(0, firstPipe);
    const lineNum = parseInt(line.slice(firstPipe + 1, secondPipe), 10);
    const text = line.slice(secondPipe + 1);

    if (!isNaN(lineNum)) {
      matches.push({ file, line: lineNum, text: truncateLine(text) });
    }
  }

  return matches;
}

async function runSystemGrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<GrepMatch[]> {
  const args = ["grep", "-rnH"];
  if (include) {
    args.push(`--include=${include}`);
  }
  args.push("--", pattern, searchPath);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), GREP_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timeout);
  }

  const output = await new Response(proc.stdout).text();
  const matches: GrepMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    if (matches.length >= MAX_MATCHES) break;

    // Format: filePath:lineNum:lineText (use indexOf for first two colons)
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon);
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const text = line.slice(secondColon + 1);

    if (!isNaN(lineNum)) {
      matches.push({ file, line: lineNum, text: truncateLine(text) });
    }
  }

  return matches;
}

export const grepTool = tool({
  description:
    "Search file contents using regex patterns. " +
    "Uses ripgrep (rg) if available, falls back to system grep. " +
    "Returns matching lines with file path and line number, sorted by file modification time.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z
      .string()
      .describe("File or directory to search in (default: current working directory)")
      .optional(),
    include: z
      .string()
      .describe("File glob filter (e.g. '*.ts', '*.{js,jsx}')")
      .optional(),
  }),
  execute: async ({ pattern, path, include }) => {
    try {
      const searchPath = path ?? process.cwd();

      // Verify path exists
      try {
        await stat(searchPath);
      } catch {
        return { error: `Path not found: ${searchPath}` };
      }

      const rgPath = getRipgrepPath();
      const matches = rgPath
        ? await runRipgrep(pattern, searchPath, include)
        : await runSystemGrep(pattern, searchPath, include);

      // Stat files for mtime and sort by mtime desc, then line number asc
      const mtimeCache = new Map<string, number>();
      for (const m of matches) {
        if (!mtimeCache.has(m.file)) {
          try {
            const fileStat = await stat(m.file);
            mtimeCache.set(m.file, fileStat.mtimeMs);
          } catch {
            mtimeCache.set(m.file, 0);
          }
        }
      }

      matches.sort((a, b) => {
        const mtimeA = mtimeCache.get(a.file) ?? 0;
        const mtimeB = mtimeCache.get(b.file) ?? 0;
        if (mtimeA !== mtimeB) return mtimeB - mtimeA;
        return a.line - b.line;
      });

      return {
        matches,
        count: matches.length,
        truncated: matches.length >= MAX_MATCHES,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Grep search failed: ${message}` };
    }
  },
});
