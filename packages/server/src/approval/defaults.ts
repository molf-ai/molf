import { fromConfig } from "./evaluate.js";
import type { CompactPermission, Ruleset } from "./types.js";

export const DEFAULT_CONFIG: CompactPermission = {
  "*": "ask",
  read_file: {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*credentials*": "deny",
    "*secret*": "deny",
    "*.env.example": "allow",
  },
  write_file: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
  edit_file: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
  glob: "allow",
  grep: "allow",
  skill: "ask",
  shell_exec: "ask",
};

export const DEFAULT_RULESET: Ruleset = fromConfig(DEFAULT_CONFIG);
