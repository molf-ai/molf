import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { resolve, dirname, join } from "path";
import { parse as parseJsonc, modify, applyEdits, type ModificationOptions } from "jsonc-parser";
import { z } from "zod";
import { parseCli, parseModelId } from "@molf-ai/protocol";
import type { ServerConfig } from "@molf-ai/protocol";
import type { ProviderRegistryConfig } from "@molf-ai/agent-core";
import { randomBytes } from "crypto";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7600;
const DEFAULT_DATA_DIR = ".";

const DEFAULT_PLUGINS: Array<{ name: string }> = [
  { name: "@molf-ai/plugin-cron" },
  { name: "@molf-ai/plugin-mcp" },
];

export interface JsonConfig {
  host?: string;
  port?: number;
  dataDir?: string;
  model?: string;
  noTls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  enabled_providers?: string[];
  custom_providers?: Record<string, CustomProviderConfig>;
  behavior?: {
    temperature?: number;
    contextPruning?: boolean;
  };
  plugins?: Array<{ name: string; config?: unknown }>;
}

export interface CustomProviderConfig {
  name: string;
  npm?: string;
  options?: Record<string, unknown>;
  models: Record<string, {
    name?: string;
    limit?: { context?: number; output?: number };
    options?: Record<string, unknown>;
  }>;
}

/** @deprecated Use `JsonConfig` instead. */
export type YamlConfig = JsonConfig;

/**
 * Load config from `config.json` (JSONC format — comments and trailing commas allowed).
 */
export function loadJsonConfig(configPath?: string): JsonConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), "config.json");

  if (!existsSync(resolvedPath)) {
    return {};
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = parseJsonc(raw) ?? {};
  const configDir = dirname(resolve(resolvedPath));

  const result: JsonConfig = {};

  if (typeof parsed.host === "string") result.host = parsed.host;
  if (typeof parsed.port === "number") result.port = parsed.port;
  if (typeof parsed.dataDir === "string") {
    result.dataDir = resolve(configDir, parsed.dataDir);
  }

  // TLS
  if (typeof parsed.noTls === "boolean") result.noTls = parsed.noTls;
  if (typeof parsed.tlsCert === "string") result.tlsCert = resolve(configDir, parsed.tlsCert);
  if (typeof parsed.tlsKey === "string") result.tlsKey = resolve(configDir, parsed.tlsKey);

  // Combined model format: "provider/model"
  if (typeof parsed.model === "string") result.model = parsed.model;

  // Provider enablement
  if (Array.isArray(parsed.enabled_providers)) {
    result.enabled_providers = parsed.enabled_providers.filter(
      (p: unknown): p is string => typeof p === "string",
    );
  }

  // Custom providers
  if (parsed.custom_providers && typeof parsed.custom_providers === "object") {
    result.custom_providers = parsed.custom_providers;
  }

  // Legacy: support old "providers" field as custom_providers
  if (!result.custom_providers && parsed.providers && typeof parsed.providers === "object") {
    result.custom_providers = parsed.providers;
  }

  // Plugins
  if (Array.isArray(parsed.plugins)) {
    result.plugins = parsed.plugins
      .filter((p: unknown): p is { name: string; config?: unknown } =>
        typeof p === "object" && p !== null && typeof (p as any).name === "string",
      )
      .map((p: { name: string; config?: unknown }) => ({ name: p.name, config: p.config }));
  }

  // Behavior
  if (parsed.behavior && typeof parsed.behavior === "object") {
    const behavior: JsonConfig["behavior"] = {};
    if (typeof parsed.behavior.temperature === "number") {
      behavior.temperature = parsed.behavior.temperature;
    }
    if (typeof parsed.behavior.contextPruning === "boolean") {
      behavior.contextPruning = parsed.behavior.contextPruning;
    }
    if (Object.keys(behavior).length > 0) result.behavior = behavior;
  }

  return result;
}

/** @deprecated Use `loadJsonConfig` instead. */
export const loadYamlConfig = loadJsonConfig;

/**
 * Modify a value in `config.json` using `jsonc-parser`, preserving comments and formatting.
 * Uses atomic write (temp file + rename in the same directory).
 */
export function modifyConfigFile(configPath: string, jsonPath: string[], value: unknown): void {
  let text = "";
  if (existsSync(configPath)) {
    text = readFileSync(configPath, "utf-8");
  }
  if (!text.trim()) text = "{}";

  const opts: ModificationOptions = {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  };
  const edits = modify(text, jsonPath, value, opts);
  const updated = applyEdits(text, edits);

  atomicWriteFile(configPath, updated);
}

/**
 * Write content to a file atomically: write to temp file, then rename.
 * Temp file is in the same directory to ensure same-filesystem rename.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.molf-tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function resolveServerConfig(
  args: ReturnType<typeof parseServerArgs>,
): ServerConfig & { token?: string; configPath: string } & {
  providerConfig: ProviderRegistryConfig;
  behavior?: JsonConfig["behavior"];
  plugins: Array<{ name: string; config?: unknown }>;
} {
  // Resolve dataDir first — configPath defaults to {dataDir}/config.json
  const dataDir = args["data-dir"] ?? resolve(process.cwd(), DEFAULT_DATA_DIR);
  const configPath = args.config ?? resolve(dataDir, "config.json");
  const json = loadJsonConfig(configPath);

  // Priority: CLI/env > JSON > defaults (dataDir from JSON can override, but configPath stays)
  const finalDataDir = json.dataDir ?? dataDir;
  const host = args.host ?? json.host ?? DEFAULT_HOST;
  const port = args.port ?? json.port ?? DEFAULT_PORT;

  // Model: env var overrides JSON; model is now optional (Step 3)
  const model = process.env.MOLF_DEFAULT_MODEL ?? json.model;

  // Validate model format if present
  if (model) {
    parseModelId(model); // throws if invalid
  }

  // Build provider registry config
  const providerConfig: ProviderRegistryConfig = {
    model,
    enabled_providers: json.enabled_providers,
    custom_providers: json.custom_providers,
    dataDir: finalDataDir,
  };

  // TLS config
  const noTls = args["no-tls"] ?? json.noTls ?? false;
  const tlsCertPath = args["tls-cert"] ?? json.tlsCert;
  const tlsKeyPath = args["tls-key"] ?? json.tlsKey;

  // Validation: cert and key must both be set or neither
  if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) {
    throw new Error("--tls-cert and --tls-key must both be provided or neither.");
  }
  if (noTls && (tlsCertPath || tlsKeyPath)) {
    throw new Error("--no-tls cannot be combined with --tls-cert/--tls-key.");
  }

  return {
    host,
    port,
    dataDir: finalDataDir,
    model: model ?? "",
    tls: !noTls,
    tlsCertPath,
    tlsKeyPath,
    token: args.token,
    configPath,
    providerConfig,
    behavior: json.behavior,
    plugins: json.plugins ?? DEFAULT_PLUGINS,
  };
}

const serverArgsSchema = z.object({
  config: z.string().transform((p) => resolve(p)).optional(),
  "data-dir": z.string().transform((p) => resolve(p)).optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  token: z.string().optional(),
  "no-tls": z.boolean().optional(),
  "tls-cert": z.string().transform((p) => resolve(p)).optional(),
  "tls-key": z.string().transform((p) => resolve(p)).optional(),
});

export function parseServerArgs(argv?: string[]) {
  return parseCli(
    {
      name: "molf-server",
      version: "0.1.0",
      description: "Molf server",
      options: {
        config: {
          type: "string",
          short: "c",
          description: "Path to config.json config file",
        },
        "data-dir": {
          type: "string",
          short: "d",
          description: "Data directory path",
          default: ".",
          env: "MOLF_DATA_DIR",
        },
        host: {
          type: "string",
          short: "H",
          description: "Host to bind to",
          default: "127.0.0.1",
          env: "MOLF_HOST",
        },
        port: {
          type: "string",
          short: "p",
          description: "Port to listen on",
          default: "7600",
          env: "MOLF_PORT",
        },
        token: {
          type: "string",
          short: "t",
          description: "Auth token (skips random generation)",
          env: "MOLF_TOKEN",
        },
        "no-tls": {
          type: "boolean",
          description: "Disable TLS (listen on ws:// instead of wss://)",
          env: "MOLF_NO_TLS",
        },
        "tls-cert": {
          type: "string",
          description: "Path to TLS certificate PEM file",
          env: "MOLF_TLS_CERT",
        },
        "tls-key": {
          type: "string",
          description: "Path to TLS private key PEM file",
          env: "MOLF_TLS_KEY",
        },
      },
      schema: serverArgsSchema,
    },
    argv,
  );
}
