import { getLogger } from "@logtape/logtape";
import { Language } from "web-tree-sitter";
import type { Parser as TreeSitterParser } from "web-tree-sitter";
import { fileURLToPath } from "url";

const logger = getLogger(["molf", "server", "approval"]);

// --- Arity table ---

/** Maps command prefixes to the number of tokens that form the "command" portion. */
const ARITY: Record<string, number> = {
  // Simple commands — arity 1
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1,
  export: 1, grep: 1, kill: 1, killall: 1, ln: 1, ls: 1,
  mkdir: 1, mv: 1, ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1,
  source: 1, tail: 1, touch: 1, unset: 1, which: 1,
  // Additional arity 1 from molf
  head: 1, wc: 1, whoami: 1, date: 1, uname: 1, printenv: 1,
  find: 1, sed: 1, awk: 1, sort: 1, uniq: 1, cut: 1, tr: 1,
  tee: 1, xargs: 1, diff: 1, curl: 1, wget: 1, tar: 1,
  zip: 1, unzip: 1, ssh: 1, scp: 1, rsync: 1, dd: 1,
  shutdown: 1, reboot: 1, mkfs: 1, sh: 1, bash: 1, zsh: 1,

  // Subcommand tools — arity 2
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  bunx: 2,
  cargo: 2,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  crictl: 2,
  deno: 2,
  docker: 2,
  doctl: 3,
  eksctl: 2,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  kind: 2,
  kubectl: 2,
  kustomize: 2,
  make: 2,
  mc: 2,
  minikube: 2,
  mongosh: 2,
  mvn: 2,
  mysql: 2,
  ng: 2,
  npm: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  podman: 2,
  poetry: 2,
  psql: 2,
  pulumi: 2,
  pyenv: 2,
  python: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,

  // Deep subcommand tools — arity 3
  "bun run": 3,
  "bun x": 3,
  "cargo add": 3,
  "cargo run": 3,
  "consul kv": 3,
  "deno task": 3,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  "eksctl create": 3,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  "kind create": 3,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  "mc admin": 3,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  "openssl req": 3,
  "openssl x509": 3,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  "podman container": 3,
  "podman image": 3,
  "pulumi stack": 3,
  "sfdx": 3,
  "terraform workspace": 3,
  "vault auth": 3,
  "vault kv": 3,
  "yarn dlx": 3,
  "yarn run": 3,
};

/**
 * Given command tokens, find the longest matching ARITY prefix
 * and return the command prefix tokens (for "always approve" pattern generation).
 */
export function prefix(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  for (let len = tokens.length; len > 0; len--) {
    const key = tokens.slice(0, len).join(" ");
    const arity = ARITY[key];
    if (arity !== undefined) {
      return tokens.slice(0, arity);
    }
  }
  return tokens.slice(0, 1); // fallback: just the binary name
}

// --- Tree-sitter WASM parser (lazy init) ---

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset);
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset;
  return fileURLToPath(new URL(asset, import.meta.url));
};

let parserPromise: Promise<TreeSitterParser> | null = null;

function getParser(): Promise<TreeSitterParser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const { Parser } = await import("web-tree-sitter");
      const { default: treeWasm } = await import(
        "web-tree-sitter/web-tree-sitter.wasm" as string,
        { with: { type: "wasm" } }
      );
      await Parser.init({ locateFile: () => resolveWasm(treeWasm) });
      const { default: bashWasm } = await import(
        "tree-sitter-bash/tree-sitter-bash.wasm" as string,
        { with: { type: "wasm" } }
      );
      const lang = await Language.load(resolveWasm(bashWasm));
      const p = new Parser();
      p.setLanguage(lang);
      logger.info("Shell parser initialized (tree-sitter-bash)");
      return p;
    })();
  }
  return parserPromise;
}

export interface ShellParseResult {
  /** Exact command text for each sub-command (for ruleset checking) */
  patterns: string[];
  /** Arity-derived "always approve" globs (e.g. "git push *") */
  always: string[];
}

/**
 * Parse a shell command string into individual sub-commands.
 * Uses tree-sitter-bash for accurate AST-based parsing.
 */
export async function parseShellCommand(command: string): Promise<ShellParseResult> {
  const parser = await getParser();
  const tree = parser.parse(command);
  if (!tree) {
    throw new Error("tree-sitter failed to parse command");
  }

  const commands: Array<{ text: string; tokens: string[] }> = [];

  for (const node of tree.rootNode.descendantsOfType("command")) {
    const tokens = extractTokens(node);
    if (tokens.length === 0) continue;

    // Capture full text including redirects if the command is inside a redirected_statement
    const text = node.parent?.type === "redirected_statement"
      ? node.parent.text.trim()
      : node.text.trim();

    commands.push({ text, tokens });
  }

  if (commands.length === 0) {
    // Fallback: treat entire command as a single entry
    const tokens = command.trim().split(/\s+/);
    return {
      patterns: [command.trim()],
      always: [makeAlwaysPattern(tokens)],
    };
  }

  const patterns: string[] = [];
  const always: string[] = [];
  for (const cmd of commands) {
    patterns.push(cmd.text);
    always.push(makeAlwaysPattern(cmd.tokens));
  }

  return { patterns, always };
}

// --- AST helpers ---

/**
 * Extract meaningful tokens from a `command` node.
 * Skips variable assignments, picks up command_name and argument words.
 */
function extractTokens(node: { type: string; text: string; childCount: number; child(i: number): { type: string; text: string } | null }): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    switch (child.type) {
      case "command_name":
      case "word":
      case "number":
        tokens.push(child.text);
        break;
      case "string":
      case "raw_string":
      case "concatenation":
      case "expansion":
      case "simple_expansion":
        tokens.push(stripQuotes(child.text));
        break;
      // Skip: variable_assignment, redirection, etc.
    }
  }
  return tokens;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// --- Shared helpers ---

/**
 * Build an "always approve" glob from command tokens using the arity table.
 * e.g. ["git", "push", "origin", "main"] -> "git push *"
 */
function makeAlwaysPattern(tokens: string[]): string {
  const prefixTokens = prefix(tokens);
  const commandPart = prefixTokens.join(" ");
  // If the command has more tokens than the prefix, add a wildcard
  if (tokens.length > prefixTokens.length) {
    return commandPart + " *";
  }
  return commandPart;
}
