import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";
import type { ServerConfig } from "@molf-ai/protocol";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7600;
const DEFAULT_DATA_DIR = ".";

export interface YamlConfig {
  host?: string;
  port?: number;
  dataDir?: string;
  llm?: { provider?: string; model?: string };
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

  if (parsed.llm && typeof parsed.llm === "object") {
    const llm: YamlConfig["llm"] = {};
    if (typeof parsed.llm.provider === "string") llm.provider = parsed.llm.provider;
    if (typeof parsed.llm.model === "string") llm.model = parsed.llm.model;
    if (llm.provider || llm.model) result.llm = llm;
  }

  return result;
}

export function resolveServerConfig(
  args: ReturnType<typeof parseServerArgs>,
): ServerConfig & { token?: string } {
  const yaml = loadYamlConfig(args.config);

  // Priority: CLI/env > YAML > defaults
  const host = args.host ?? yaml.host ?? DEFAULT_HOST;
  const port = args.port ?? yaml.port ?? DEFAULT_PORT;
  const dataDir = args["data-dir"] ?? yaml.dataDir ?? resolve(process.cwd(), DEFAULT_DATA_DIR);

  // LLM: env vars override YAML (these are env-to-YAML overrides, not CLI options)
  const provider = process.env.MOLF_LLM_PROVIDER ?? yaml.llm?.provider;
  const model = process.env.MOLF_LLM_MODEL ?? yaml.llm?.model;

  if (!provider || !model) {
    throw new Error(
      "LLM provider and model are required. Set llm.provider and llm.model in molf.yaml, " +
        "or set MOLF_LLM_PROVIDER and MOLF_LLM_MODEL environment variables.",
    );
  }

  return { host, port, dataDir, llm: { provider, model }, token: args.token };
}

const serverArgsSchema = z.object({
  config: z.string().transform((p) => resolve(p)).optional(),
  "data-dir": z.string().transform((p) => resolve(p)).optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  token: z.string().optional(),
});

export function parseServerArgs(argv?: string[]) {
  return parseCli(
    {
      name: "molf-server",
      version: "0.1.0",
      description: "Molf server",
      usage: "bun run dev:server -- [options]",
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
      },
      schema: serverArgsSchema,
    },
    argv,
  );
}
