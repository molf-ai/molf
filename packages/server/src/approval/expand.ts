import { homedir } from "os";

/**
 * Expand `~/` and `$HOME/` prefixes in a pattern to the actual home directory.
 * Returns the pattern unchanged if no expansion applies.
 */
export function expand(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1);
  if (pattern === "$HOME") return homedir();
  if (pattern.startsWith("$HOME/")) return homedir() + pattern.slice(5);
  return pattern;
}
