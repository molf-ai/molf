import type { CompactPermission } from "./types.js";

/**
 * Serialize a CompactPermission config to a human-readable JSONC string.
 * Produces the compact nested format: `{ "tool": "action" }` or `{ "tool": { "pattern": "action" } }`.
 */
export function serializeCompactConfig(config: CompactPermission): string {
  const lines: string[] = [];
  lines.push("// Tool approval permissions for this worker.");
  lines.push("// Edit this file to customize which tool calls are auto-allowed,");
  lines.push("// auto-denied, or require manual approval.");
  lines.push("//");
  lines.push("// Format:");
  lines.push('//   "toolName": "action"              — applies to all patterns');
  lines.push('//   "toolName": { "pattern": "action" } — per-pattern rules');
  lines.push('//   "*": "ask"                        — catch-all default');
  lines.push("//");
  lines.push('// Actions: "allow" | "deny" | "ask"');
  lines.push("// Last matching rule wins. Patterns support globs (e.g. \"*.env\", \"git *\").");
  lines.push("// Use ~/ or $HOME/ in patterns for home directory paths.");
  lines.push("{");

  const entries = Object.entries(config);
  for (let i = 0; i < entries.length; i++) {
    const [permission, value] = entries[i];
    const comma = i < entries.length - 1 ? "," : "";

    if (typeof value === "string") {
      lines.push(`  ${JSON.stringify(permission)}: ${JSON.stringify(value)}${comma}`);
    } else {
      const patternEntries = Object.entries(value);
      if (patternEntries.length === 0) {
        lines.push(`  ${JSON.stringify(permission)}: {}${comma}`);
      } else {
        lines.push(`  ${JSON.stringify(permission)}: {`);
        for (let j = 0; j < patternEntries.length; j++) {
          const [pattern, action] = patternEntries[j];
          const pComma = j < patternEntries.length - 1 ? "," : "";
          lines.push(`    ${JSON.stringify(pattern)}: ${JSON.stringify(action)}${pComma}`);
        }
        lines.push(`  }${comma}`);
      }
    }
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}
