import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { parseCli, type CliConfig } from "../src/cli.js";

const testSchema = z.object({
  config: z.string().optional(),
  port: z.coerce.number().optional(),
  verbose: z.boolean().optional(),
  name: z.string().optional(),
});

const testCliConfig: CliConfig<typeof testSchema> = {
  name: "test-cli",
  version: "1.0.0",
  description: "Test CLI",
  options: {
    config: {
      type: "string",
      short: "c",
      description: "Config file path",
    },
    port: {
      type: "string",
      short: "p",
      description: "Port",
      default: "3000",
    },
    verbose: {
      type: "boolean",
      short: "V",
      description: "Verbose mode",
    },
    name: {
      type: "string",
      short: "n",
      description: "Name",
      env: "TEST_CLI_NAME",
    },
  },
  schema: testSchema,
};

let env: EnvGuard;
beforeEach(() => {
  env = createEnvGuard();
});
afterEach(() => {
  env.restore();
});

describe("parseCli", () => {
  test("parse valid flags", () => {
    const result = parseCli(testCliConfig, ["--config", "/path/to/config", "--port", "8080"]);
    expect(result.config).toBe("/path/to/config");
    expect(result.port).toBe(8080);
  });

  test("short flag aliases", () => {
    const result = parseCli(testCliConfig, ["-c", "/path/to/config"]);
    expect(result.config).toBe("/path/to/config");
  });

  test("missing required flag with env fallback", () => {
    env.set("TEST_CLI_NAME", "from-env");
    const result = parseCli(testCliConfig, []);
    expect(result.name).toBe("from-env");
  });

  test("CLI flag overrides env var", () => {
    env.set("TEST_CLI_NAME", "from-env");
    const result = parseCli(testCliConfig, ["--name", "from-cli"]);
    expect(result.name).toBe("from-cli");
  });

  test("no flags returns defaults from zod", () => {
    const result = parseCli(testCliConfig, []);
    expect(result.config).toBeUndefined();
    expect(result.verbose).toBeUndefined();
  });
});

describe("--help flag", () => {
  test("--help prints formatted help and exits with 0", () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    }) as never;

    try {
      parseCli(testCliConfig, ["--help"]);
    } catch (e: any) {
      expect(e.message).toBe("__EXIT__");
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("test-cli v1.0.0");
    expect(output).toContain("Options:");
  });

  test("formatHelp includes option descriptions, defaults, and env annotations", () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    process.exit = (() => { throw new Error("__EXIT__"); }) as never;

    try {
      parseCli(testCliConfig, ["--help"]);
    } catch {}
    finally {
      console.log = origLog;
      process.exit = origExit;
    }

    const output = logs.join("\n");
    expect(output).toContain("Config file path");
    expect(output).toContain("[default: 3000]");
    expect(output).toContain("[env: TEST_CLI_NAME]");
    expect(output).toContain("--help");
    expect(output).toContain("--version");
  });

  test("help output includes custom usage string", () => {
    const configWithUsage: CliConfig<typeof testSchema> = {
      ...testCliConfig,
      usage: "test-cli [options]",
    };
    const logs: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    process.exit = (() => { throw new Error("__EXIT__"); }) as never;

    try {
      parseCli(configWithUsage, ["--help"]);
    } catch {}
    finally {
      console.log = origLog;
      process.exit = origExit;
    }

    const output = logs.join("\n");
    expect(output).toContain("Usage: test-cli [options]");
  });

  test("help output includes Environment variables section", () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    process.exit = (() => { throw new Error("__EXIT__"); }) as never;

    try {
      parseCli(testCliConfig, ["--help"]);
    } catch {}
    finally {
      console.log = origLog;
      process.exit = origExit;
    }

    const output = logs.join("\n");
    expect(output).toContain("Environment variables:");
    expect(output).toContain("TEST_CLI_NAME");
  });
});

describe("--version flag", () => {
  test("--version prints version and exits with 0", () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    }) as never;

    try {
      parseCli(testCliConfig, ["--version"]);
    } catch (e: any) {
      expect(e.message).toBe("__EXIT__");
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("test-cli v1.0.0");
  });
});

describe("parse errors", () => {
  test("unknown flag causes error exit with code 1", () => {
    const errors: string[] = [];
    const origError = console.error;
    const origExit = process.exit;
    console.error = (...args: any[]) => errors.push(args.join(" "));

    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    }) as never;

    try {
      parseCli(testCliConfig, ["--unknown-flag"]);
    } catch (e: any) {
      expect(e.message).toBe("__EXIT__");
    } finally {
      console.error = origError;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("Error:");
    expect(output).toContain("--help");
  });

  test("zod validation error prints field-level messages", () => {
    // port expects a coercible number; passing a non-numeric string will fail
    const strictSchema = z.object({
      port: z.coerce.number().min(1).max(65535),
    });
    const strictConfig: CliConfig<typeof strictSchema> = {
      name: "strict-cli",
      version: "1.0.0",
      description: "Strict CLI",
      options: {
        port: {
          type: "string",
          short: "p",
          description: "Port number",
        },
      },
      schema: strictSchema,
    };

    const errors: string[] = [];
    const origError = console.error;
    const origExit = process.exit;
    console.error = (...args: any[]) => errors.push(args.join(" "));

    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__EXIT__");
    }) as never;

    try {
      parseCli(strictConfig, ["--port", "not-a-number"]);
    } catch (e: any) {
      expect(e.message).toBe("__EXIT__");
    } finally {
      console.error = origError;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("Invalid arguments");
    expect(output).toContain("--port");
  });
});
