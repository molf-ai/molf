import type { GroupedRuleset } from "./types.js";

export const DEFAULT_RULESET: GroupedRuleset = {
  version: 1,
  rules: {
    // Reading tools — safe by default
    read_file: {
      default: "allow",
      deny: ["*.env", "*.env.*", "*credentials*", "*secret*"],
      allow: ["*.env.example"],
    },

    glob: {
      default: "allow",
    },

    grep: {
      default: "allow",
    },

    // Writing tools — safe by default, deny secrets
    write_file: {
      default: "allow",
      deny: ["*.env", "*.env.*"],
    },

    edit_file: {
      default: "allow",
      deny: ["*.env", "*.env.*"],
    },

    // Skill — ask before loading skill instructions
    skill: {
      default: "ask",
    },

    // Shell — ask by default
    shell_exec: {
      default: "ask",
      allow: [],
      deny: [],
    },

    // Catch-all — unknown tools ask
    "*": {
      default: "ask",
    },
  },
};
