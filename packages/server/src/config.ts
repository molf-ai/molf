import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCli, parseModelId } from "@molf-ai/protocol";
import type { ServerConfig } from "@molf-ai/protocol";
import type { ProviderRegistryConfig } from "@molf-ai/agent-core";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7600;
const DEFAULT_DATA_DIR = ".";

const DEFAULT_PLUGINS: Array<{ name: string }> = [
  { name: "@molf-ai/plugin-cron" },
  { name: "@molf-ai/plugin-mcp" },
];

export interface YamlConfig {
  host?: string;
  port?: number;
  dataDir?: string;
  model?: string;
  noTls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  enabled_providers?: string[];
  enable_all_providers?: boolean;
  providers?: ProviderRegistryConfig["providers"];
  behavior?: {
    temperature?: number;
    contextPruning?: boolean;
  };
  plugins?: Array<{ name: string; config?: unknown }>;
}

export function loadYamlConfig(configPath?: string): YamlConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), "molf.yaml");

  if (!existsSync(resolvedPath)) {
    return {};
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = parseYaml(raw) ?? {};
  const configDir = dirname(resolve(resolvedPath));

  const result: YamlConfig = {};

  if (typeof parsed.host === "string") result.host = parsed.host;
  if (typeof parsed.port === "number") result.port = parsed.port;
  if (typeof parsed.dataDir === "string") {
    result.dataDir = resolve(configDir, parsed.dataDir);
  }

  // TLS
  if (typeof parsed.noTls === "boolean") result.noTls = parsed.noTls;
  if (typeof parsed.tlsCert === "string") result.tlsCert = resolve(configDir, parsed.tlsCert);
  if (typeof parsed.tlsKey === "string") result.tlsKey = resolve(configDir, parsed.tlsKey);

  // New combined model format: "provider/model"
  if (typeof parsed.model === "string") result.model = parsed.model;

  // Provider enablement
  if (Array.isArray(parsed.enabled_providers)) {
    result.enabled_providers = parsed.enabled_providers.filter(
      (p: unknown): p is string => typeof p === "string",
    );
  }
  if (typeof parsed.enable_all_providers === "boolean") {
    result.enable_all_providers = parsed.enable_all_providers;
  }

  // Custom/override providers
  if (parsed.providers && typeof parsed.providers === "object") {
    result.providers = parsed.providers;
  }

  // Behavior defaults
  // Plugins
  if (Array.isArray(parsed.plugins)) {
    result.plugins = parsed.plugins
      .filter((p: unknown): p is { name: string; config?: unknown } =>
        typeof p === "object" && p !== null && typeof (p as any).name === "string",
      )
      .map((p: { name: string; config?: unknown }) => ({ name: p.name, config: p.config }));
  }

  if (parsed.behavior && typeof parsed.behavior === "object") {
    const behavior: YamlConfig["behavior"] = {};
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

export function resolveServerConfig(
  args: ReturnType<typeof parseServerArgs>,
): ServerConfig & { token?: string } & { providerConfig: ProviderRegistryConfig; behavior?: YamlConfig["behavior"]; plugins: Array<{ name: string; config?: unknown }> } {
  const yaml = loadYamlConfig(args.config);

  // Priority: CLI/env > YAML > defaults
  const host = args.host ?? yaml.host ?? DEFAULT_HOST;
  const port = args.port ?? yaml.port ?? DEFAULT_PORT;
  const dataDir = args["data-dir"] ?? yaml.dataDir ?? resolve(process.cwd(), DEFAULT_DATA_DIR);

  // Model: env var overrides YAML
  const model = process.env.MOLF_DEFAULT_MODEL ?? yaml.model;

  if (!model) {
    throw new Error(
      "Default model is required. Set `model` in molf.yaml (e.g. model: anthropic/claude-sonnet-4-20250514), " +
        "or set MOLF_DEFAULT_MODEL environment variable.",
    );
  }

  // Validate model format
  parseModelId(model); // throws if invalid

  // Build provider registry config
  // Priority: YAML explicit value > env var > undefined
  const enableAll =
    yaml.enable_all_providers ??
    (process.env.MOLF_ENABLE_ALL_PROVIDERS
      ? process.env.MOLF_ENABLE_ALL_PROVIDERS === "1" ||
        process.env.MOLF_ENABLE_ALL_PROVIDERS === "true"
      : undefined);
  const providerConfig: ProviderRegistryConfig = {
    model,
    enabled_providers: yaml.enabled_providers,
    enable_all_providers: enableAll,
    providers: yaml.providers,
    dataDir,
  };

  // TLS config
  const noTls = args["no-tls"] ?? yaml.noTls ?? false;
  const tlsCertPath = args["tls-cert"] ?? yaml.tlsCert;
  const tlsKeyPath = args["tls-key"] ?? yaml.tlsKey;

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
    dataDir,
    model,
    tls: !noTls,
    tlsCertPath,
    tlsKeyPath,
    token: args.token,
    providerConfig,
    behavior: yaml.behavior,
    plugins: yaml.plugins ?? DEFAULT_PLUGINS,
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
          description: "Path to molf.yaml config file",
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
