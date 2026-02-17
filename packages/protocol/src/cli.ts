import { parseArgs } from "node:util";
import type { z } from "zod";
import { errorMessage } from "./helpers.js";

export interface CliOption {
  type: "string" | "boolean";
  short?: string;
  description: string;
  default?: string | boolean;
  env?: string;
  required?: boolean;
}

export interface CliConfig<T extends z.ZodType> {
  name: string;
  version: string;
  description: string;
  usage?: string;
  options: Record<string, CliOption>;
  schema: T;
}

function formatHelp(config: CliConfig<z.ZodType>): string {
  const lines: string[] = [];
  lines.push(`${config.name} v${config.version} - ${config.description}`);
  lines.push("");

  if (config.usage) {
    lines.push(`Usage: ${config.usage}`);
    lines.push("");
  }

  lines.push("Options:");

  // Collect all options including built-in help/version
  const allOptions: Record<string, CliOption> = {
    ...config.options,
    help: { type: "boolean", short: "h", description: "Show this help message" },
    version: { type: "boolean", short: "v", description: "Show version" },
  };

  // Calculate padding for alignment
  const entries = Object.entries(allOptions).map(([name, opt]) => {
    const shortFlag = opt.short ? `-${opt.short}, ` : "    ";
    const longFlag = `--${name}`;
    const valueSuffix = opt.type === "string" ? " <value>" : "";
    const flag = `  ${shortFlag}${longFlag}${valueSuffix}`;
    return { flag, opt };
  });

  const maxFlagLen = Math.max(...entries.map((e) => e.flag.length));

  for (const { flag, opt } of entries) {
    const padding = " ".repeat(maxFlagLen - flag.length + 2);
    let desc = opt.description;
    if (opt.required) desc += " (required)";
    if (opt.default !== undefined) desc += `  [default: ${opt.default}]`;
    if (opt.env) desc += `  [env: ${opt.env}]`;
    lines.push(`${flag}${padding}${desc}`);
  }

  // Collect env var mappings
  const envEntries = Object.entries(config.options).filter(([, opt]) => opt.env);
  if (envEntries.length > 0) {
    lines.push("");
    lines.push("Environment variables:");
    const maxEnvLen = Math.max(...envEntries.map(([, opt]) => opt.env!.length));
    for (const [name, opt] of envEntries) {
      const padding = " ".repeat(maxEnvLen - opt.env!.length + 3);
      lines.push(`  ${opt.env!}${padding}--${name}`);
    }
  }

  return lines.join("\n");
}

export function parseCli<T extends z.ZodType>(
  config: CliConfig<T>,
  argv?: string[],
): z.infer<T> {
  const args = argv ?? process.argv.slice(2);

  // Build parseArgs options
  const parseArgsOptions: Record<
    string,
    { type: "string" | "boolean"; short?: string }
  > = {};

  for (const [name, opt] of Object.entries(config.options)) {
    parseArgsOptions[name] = { type: opt.type };
    if (opt.short) parseArgsOptions[name].short = opt.short;
  }

  // Add built-in flags
  parseArgsOptions.help = { type: "boolean", short: "h" };
  parseArgsOptions.version = { type: "boolean", short: "v" };

  // Parse arguments
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: parseArgsOptions, strict: true });
  } catch (err) {
    console.error(`Error: ${errorMessage(err)}\n`);
    console.error(`Run '${config.name} --help' for usage information.`);
    process.exit(1);
  }

  const values = parsed.values;

  // Handle --help
  if (values.help) {
    console.log(formatHelp(config));
    process.exit(0);
  }

  // Handle --version
  if (values.version) {
    console.log(`${config.name} v${config.version}`);
    process.exit(0);
  }

  // Merge: CLI args > env vars > (zod defaults handle the rest)
  const merged: Record<string, unknown> = {};

  for (const [name, opt] of Object.entries(config.options)) {
    const cliValue = values[name];
    if (cliValue !== undefined) {
      merged[name] = cliValue;
    } else if (opt.env && process.env[opt.env]) {
      merged[name] = process.env[opt.env];
    }
    // If neither CLI nor env provides a value, omit the key
    // so zod defaults can apply
  }

  // Validate with zod
  const result = config.schema.safeParse(merged);
  if (!result.success) {
    console.error("Invalid arguments:\n");
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      console.error(`  --${path}: ${issue.message}`);
    }
    console.error(`\nRun '${config.name} --help' for usage information.`);
    process.exit(1);
  }

  return result.data;
}
