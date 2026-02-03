import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";
import type { ServerConfig } from "@molf-ai/protocol";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7600;
const DEFAULT_DATA_DIR = ".";

export function loadConfig(configPath?: string): ServerConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), "molf.yaml");

  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let dataDir: string;
  let yamlProvider: string | undefined;
  let yamlModel: string | undefined;

  if (!existsSync(resolvedPath)) {
    dataDir = resolve(process.cwd(), DEFAULT_DATA_DIR);
  } else {
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = parseYaml(raw) ?? {};
    const configDir = dirname(resolve(resolvedPath));

    host = typeof parsed.host === "string" ? parsed.host : DEFAULT_HOST;
    port = typeof parsed.port === "number" ? parsed.port : DEFAULT_PORT;
    const rawDataDir = typeof parsed.dataDir === "string" ? parsed.dataDir : DEFAULT_DATA_DIR;
    dataDir = resolve(configDir, rawDataDir);

    // Parse LLM config from YAML
    if (parsed.llm && typeof parsed.llm === "object") {
      if (typeof parsed.llm.provider === "string") yamlProvider = parsed.llm.provider;
      if (typeof parsed.llm.model === "string") yamlModel = parsed.llm.model;
    }
  }

  // Env vars override YAML
  const provider = process.env.MOLF_LLM_PROVIDER ?? yamlProvider;
  const model = process.env.MOLF_LLM_MODEL ?? yamlModel;

  if (!provider || !model) {
    throw new Error(
      "LLM provider and model are required. Set llm.provider and llm.model in molf.yaml, " +
        "or set MOLF_LLM_PROVIDER and MOLF_LLM_MODEL environment variables.",
    );
  }

  return { host, port, dataDir, llm: { provider, model } };
}

const serverArgsSchema = z.object({
  config: z.string().transform((p) => resolve(p)).optional(),
  "data-dir": z.string().transform((p) => resolve(p)).optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
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
        },
        host: {
          type: "string",
          short: "H",
          description: "Host to bind to",
          default: "127.0.0.1",
        },
        port: {
          type: "string",
          short: "p",
          description: "Port to listen on",
          default: "7600",
        },
      },
      schema: serverArgsSchema,
    },
    argv,
  );
}
