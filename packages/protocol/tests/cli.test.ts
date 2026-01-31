import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { parseCli } from "../src/cli.js";

// Mock process.exit to capture exit calls
let exitCode: number | undefined;
let consoleOutput: string[] = [];
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

function mockProcessExit() {
  exitCode = undefined;
  consoleOutput = [];
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
}

function restoreProcessExit() {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
}

const testSchema = z.object({
  name: z.string().min(1),
  port: z.coerce.number().default(3000),
  verbose: z.boolean().default(false),
});

const testConfig = {
  name: "test-cli",
  version: "1.0.0",
  description: "A test CLI",
  options: {
    name: {
      type: "string" as const,
      short: "n",
      description: "The name",
      required: true,
    },
    port: {
      type: "string" as const,
      short: "p",
      description: "Port number",
      default: "3000",
    },
    verbose: {
      type: "boolean" as const,
      description: "Verbose output",
    },
  },
  schema: testSchema,
};

describe("parseCli", () => {
  beforeEach(() => mockProcessExit());
  afterEach(() => restoreProcessExit());

  test("parses string arguments", () => {
    const result = parseCli(testConfig, ["--name", "hello"]);
    expect(result.name).toBe("hello");
  });

  test("parses short aliases", () => {
    const result = parseCli(testConfig, ["-n", "hello"]);
    expect(result.name).toBe("hello");
  });

  test("parses boolean flags", () => {
    const result = parseCli(testConfig, ["--name", "hello", "--verbose"]);
    expect(result.verbose).toBe(true);
  });

  test("applies zod defaults when args not provided", () => {
    const result = parseCli(testConfig, ["--name", "hello"]);
    expect(result.port).toBe(3000);
    expect(result.verbose).toBe(false);
  });

  test("CLI args override defaults", () => {
    const result = parseCli(testConfig, ["--name", "hello", "--port", "8080"]);
    expect(result.port).toBe(8080);
  });

  test("env var fallback when CLI arg not provided", () => {
    const configWithEnv = {
      ...testConfig,
      options: {
        ...testConfig.options,
        name: { ...testConfig.options.name, env: "TEST_NAME" },
      },
    };

    const originalEnv = process.env.TEST_NAME;
    process.env.TEST_NAME = "from-env";
    try {
      const result = parseCli(configWithEnv, []);
      expect(result.name).toBe("from-env");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TEST_NAME;
      } else {
        process.env.TEST_NAME = originalEnv;
      }
    }
  });

  test("CLI args take precedence over env vars", () => {
    const configWithEnv = {
      ...testConfig,
      options: {
        ...testConfig.options,
        name: { ...testConfig.options.name, env: "TEST_NAME" },
      },
    };

    const originalEnv = process.env.TEST_NAME;
    process.env.TEST_NAME = "from-env";
    try {
      const result = parseCli(configWithEnv, ["--name", "from-cli"]);
      expect(result.name).toBe("from-cli");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TEST_NAME;
      } else {
        process.env.TEST_NAME = originalEnv;
      }
    }
  });

  test("--help prints help text and exits 0", () => {
    try {
      parseCli(testConfig, ["--help"]);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(0);
    const output = consoleOutput.join("\n");
    expect(output).toContain("test-cli v1.0.0");
    expect(output).toContain("--name");
    expect(output).toContain("--help");
    expect(output).toContain("--version");
  });

  test("-h prints help text and exits 0", () => {
    try {
      parseCli(testConfig, ["-h"]);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(0);
    const output = consoleOutput.join("\n");
    expect(output).toContain("test-cli v1.0.0");
  });

  test("--version prints version and exits 0", () => {
    try {
      parseCli(testConfig, ["--version"]);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(0);
    expect(consoleOutput.join("\n")).toContain("test-cli v1.0.0");
  });

  test("-v prints version and exits 0", () => {
    try {
      parseCli(testConfig, ["-v"]);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(0);
    expect(consoleOutput.join("\n")).toContain("test-cli v1.0.0");
  });

  test("unknown flag exits with error", () => {
    try {
      parseCli(testConfig, ["--unknown"]);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(1);
    const output = consoleOutput.join("\n");
    expect(output).toContain("Error:");
  });

  test("zod validation failure exits with error", () => {
    try {
      parseCli(testConfig, []);
    } catch {
      // expected process.exit
    }
    expect(exitCode).toBe(1);
    const output = consoleOutput.join("\n");
    expect(output).toContain("Invalid arguments");
  });

  test("help text shows env var info", () => {
    const configWithEnv = {
      ...testConfig,
      options: {
        ...testConfig.options,
        name: { ...testConfig.options.name, env: "MY_NAME" },
      },
    };

    try {
      parseCli(configWithEnv, ["--help"]);
    } catch {
      // expected process.exit
    }
    const output = consoleOutput.join("\n");
    expect(output).toContain("MY_NAME");
    expect(output).toContain("Environment variables:");
  });

  test("help text shows required marker", () => {
    try {
      parseCli(testConfig, ["--help"]);
    } catch {
      // expected process.exit
    }
    const output = consoleOutput.join("\n");
    expect(output).toContain("(required)");
  });

  test("help text shows default values", () => {
    try {
      parseCli(testConfig, ["--help"]);
    } catch {
      // expected process.exit
    }
    const output = consoleOutput.join("\n");
    expect(output).toContain("[default: 3000]");
  });
});
