import type { GroupedRuleset, ToolRule } from "./types.js";

/**
 * Serialize a GroupedRuleset to a human-readable JSONC string with comments.
 */
export function serializeRuleset(ruleset: GroupedRuleset): string {
  const lines: string[] = [];
  lines.push("// Tool approval permissions for this worker.");
  lines.push("// Edit this file to customize which tool calls are auto-allowed,");
  lines.push("// auto-denied, or require manual approval.");
  lines.push("//");
  lines.push("// Each tool entry has:");
  lines.push('//   "default": "allow" | "deny" | "ask"');
  lines.push('//   "allow": [...glob patterns...]   — override default to allow');
  lines.push('//   "deny":  [...glob patterns...]   — override default to deny (wins over allow)');
  lines.push("//");
  lines.push('// The "*" entry is the catch-all for tools not listed above.');
  lines.push("// Shell commands are matched by their full command text (e.g. \"git status\").");
  lines.push("// File tools are matched by file path (e.g. \"*.env\").");
  lines.push("{");
  lines.push(`  "version": ${ruleset.version},`);
  lines.push(`  "rules": {`);

  const entries = Object.entries(ruleset.rules);
  for (let i = 0; i < entries.length; i++) {
    const [toolName, rule] = entries[i];
    const isLast = i === entries.length - 1;
    lines.push(...serializeRule(toolName, rule, isLast));
    if (!isLast) lines.push("");
  }

  lines.push("  }");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function serializeRule(toolName: string, rule: ToolRule, isLast: boolean): string[] {
  const lines: string[] = [];
  const hasArrays = (rule.allow && rule.allow.length > 0) || (rule.deny && rule.deny.length > 0);

  if (!hasArrays) {
    // Compact single-line form
    lines.push(`    "${toolName}": { "default": "${rule.default}" }${isLast ? "" : ","}`);
    return lines;
  }

  lines.push(`    "${toolName}": {`);
  lines.push(`      "default": "${rule.default}"${rule.deny || rule.allow ? "," : ""}`);

  if (rule.allow && rule.allow.length > 0) {
    lines.push(`      "allow": [`);
    for (let j = 0; j < rule.allow.length; j++) {
      const comma = j < rule.allow.length - 1 ? "," : "";
      lines.push(`        "${rule.allow[j]}"${comma}`);
    }
    lines.push(`      ]${rule.deny && rule.deny.length > 0 ? "," : ""}`);
  }

  if (rule.deny && rule.deny.length > 0) {
    lines.push(`      "deny": [`);
    for (let j = 0; j < rule.deny.length; j++) {
      const comma = j < rule.deny.length - 1 ? "," : "";
      lines.push(`        "${rule.deny[j]}"${comma}`);
    }
    lines.push(`      ]`);
  }

  lines.push(`    }${isLast ? "" : ","}`);
  return lines;
}
