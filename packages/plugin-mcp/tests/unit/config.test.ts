import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { type LogRecord, configure, reset } from "@logtape/logtape";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { loadMcpConfig, interpolateEnv } from "../../src/config.js";

let tmp: TmpDir;
let env: EnvGuard;

beforeAll(() => {
  tmp = createTmpDir();
  env = createEnvGuard();
});

afterAll(() => {
  env.restore();
  tmp.cleanup();
});

describe("loadMcpConfig", () => {
  test("valid config parsing returns McpConfig", () => {
    const workdir = `${tmp.path}/valid`;
    tmp.writeFile(
      "valid/.mcp.json",
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: {},
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    expect(config).not.toBeNull();
    expect(config!.mcpServers.filesystem).toBeDefined();
    const srv = config!.mcpServers.filesystem;
    expect(srv.type).toBe("stdio");
    if (srv.type === "stdio") {
      expect(srv.command).toBe("npx");
      expect(srv.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
      expect(srv.env).toEqual({});
    }
  });

  test("missing config file returns null", () => {
    const workdir = `${tmp.path}/no-config`;
    // Just the workdir, no .mcp.json
    tmp.writeFile("no-config/.gitkeep", "");

    const config = loadMcpConfig(workdir);
    expect(config).toBeNull();
  });

  test("invalid JSON throws", () => {
    const workdir = `${tmp.path}/bad-json`;
    tmp.writeFile("bad-json/.mcp.json", "{ not valid json }}}");

    expect(() => loadMcpConfig(workdir)).toThrow(/not valid JSON/);
  });

  test("Zod validation: missing command for stdio type throws", () => {
    const workdir = `${tmp.path}/no-cmd`;
    tmp.writeFile(
      "no-cmd/.mcp.json",
      JSON.stringify({
        mcpServers: {
          broken: {
            type: "stdio",
            args: ["--help"],
          },
        },
      }),
    );

    expect(() => loadMcpConfig(workdir)).toThrow();
  });

  test("Zod validation: wrong type throws", () => {
    const workdir = `${tmp.path}/wrong-type`;
    tmp.writeFile(
      "wrong-type/.mcp.json",
      JSON.stringify({
        mcpServers: {
          broken: {
            command: 123,
          },
        },
      }),
    );

    expect(() => loadMcpConfig(workdir)).toThrow();
  });

  test("env var interpolation: ${MY_VAR} resolved from process.env", () => {
    const workdir = `${tmp.path}/env-interp`;
    env.set("MY_VAR", "resolved-value");

    tmp.writeFile(
      "env-interp/.mcp.json",
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["${MY_VAR}"],
            env: {},
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.test;
    if (srv.type === "stdio") {
      expect(srv.args).toEqual(["resolved-value"]);
    }
  });

  test("${WORKDIR} resolves to the workdir argument", () => {
    const workdir = `${tmp.path}/workdir-var`;
    tmp.writeFile(
      "workdir-var/.mcp.json",
      JSON.stringify({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "server-fs", "${WORKDIR}"],
            env: {},
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.fs;
    if (srv.type === "stdio") {
      expect(srv.args).toEqual(["-y", "server-fs", workdir]);
    }
  });

  test("missing var resolves to empty string with warning", async () => {
    const workdir = `${tmp.path}/missing-var`;
    // Ensure the var is not set
    env.delete("DEFINITELY_NOT_SET_XYZ_ABC");

    tmp.writeFile(
      "missing-var/.mcp.json",
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["${DEFINITELY_NOT_SET_XYZ_ABC}"],
            env: {},
          },
        },
      }),
    );

    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      const config = loadMcpConfig(workdir);
      const srv = config!.mcpServers.test;
      if (srv.type === "stdio") {
        expect(srv.args).toEqual([""]);
      }
      const warnRecord = buffer.find((r) => r.level === "warning");
      expect(warnRecord).toBeTruthy();
    } finally {
      await reset();
    }
  });

  test("interpolation applied in command, args, and env values", () => {
    const workdir = `${tmp.path}/interp-all`;
    env.set("CMD_VAR", "my-command");
    env.set("ARG_VAR", "my-arg");
    env.set("ENV_VAR", "my-env-value");

    tmp.writeFile(
      "interp-all/.mcp.json",
      JSON.stringify({
        mcpServers: {
          test: {
            command: "${CMD_VAR}",
            args: ["${ARG_VAR}", "literal"],
            env: {
              TOKEN: "${ENV_VAR}",
            },
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.test;
    if (srv.type === "stdio") {
      expect(srv.command).toBe("my-command");
      expect(srv.args).toEqual(["my-arg", "literal"]);
      expect(srv.env.TOKEN).toBe("my-env-value");
    }
  });

  test("interpolation NOT applied to env keys", () => {
    const workdir = `${tmp.path}/env-keys`;
    env.set("KEY_VAR", "should-not-be-used");

    tmp.writeFile(
      "env-keys/.mcp.json",
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            env: {
              "${KEY_VAR}": "value",
            },
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.test;
    // The key should remain as literal "${KEY_VAR}", not interpolated
    if (srv.type === "stdio") {
      expect(srv.env).toHaveProperty("${KEY_VAR}");
      expect(srv.env["${KEY_VAR}"]).toBe("value");
    }
  });

  test("http server config is parsed correctly", () => {
    const workdir = `${tmp.path}/http-basic`;
    tmp.writeFile(
      "http-basic/.mcp.json",
      JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.example.com/mcp",
            headers: { Authorization: "Bearer token123" },
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    expect(config).not.toBeNull();
    const srv = config!.mcpServers.github;
    expect(srv.type).toBe("http");
    if (srv.type === "http") {
      expect(srv.url).toBe("https://api.example.com/mcp");
      expect(srv.headers).toEqual({ Authorization: "Bearer token123" });
    }
  });

  test("http config without headers uses empty object", () => {
    const workdir = `${tmp.path}/http-no-headers`;
    tmp.writeFile(
      "http-no-headers/.mcp.json",
      JSON.stringify({
        mcpServers: {
          srv: {
            type: "http",
            url: "https://api.example.com/mcp",
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.srv;
    expect(srv.type).toBe("http");
    if (srv.type === "http") {
      expect(srv.headers).toEqual({});
    }
  });

  test("http config: env interpolation in url and headers", () => {
    const workdir = `${tmp.path}/http-interp`;
    env.set("MCP_TOKEN", "secret-token");
    env.set("MCP_HOST", "api.example.com");

    tmp.writeFile(
      "http-interp/.mcp.json",
      JSON.stringify({
        mcpServers: {
          srv: {
            type: "http",
            url: "https://${MCP_HOST}/mcp",
            headers: { Authorization: "Bearer ${MCP_TOKEN}" },
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    const srv = config!.mcpServers.srv;
    if (srv.type === "http") {
      expect(srv.url).toBe("https://api.example.com/mcp");
      expect(srv.headers.Authorization).toBe("Bearer secret-token");
    }
  });

  test("missing url for http type throws", () => {
    const workdir = `${tmp.path}/http-no-url`;
    tmp.writeFile(
      "http-no-url/.mcp.json",
      JSON.stringify({
        mcpServers: {
          broken: {
            type: "http",
          },
        },
      }),
    );

    expect(() => loadMcpConfig(workdir)).toThrow();
  });

  test("stdio config without type field defaults to stdio", () => {
    const workdir = `${tmp.path}/no-type-field`;
    tmp.writeFile(
      "no-type-field/.mcp.json",
      JSON.stringify({
        mcpServers: {
          legacy: {
            command: "npx",
            args: ["-y", "some-server"],
            env: {},
          },
        },
      }),
    );

    const config = loadMcpConfig(workdir);
    expect(config).not.toBeNull();
    const srv = config!.mcpServers.legacy;
    expect(srv.type).toBe("stdio");
    if (srv.type === "stdio") {
      expect(srv.command).toBe("npx");
    }
  });

  test("enabled: false parses correctly for stdio server", () => {
    const workdir = `${tmp.path}/enabled-false`;
    tmp.writeFile("enabled-false/.mcp.json", JSON.stringify({
      mcpServers: {
        disabled: { command: "echo", args: [], env: {}, enabled: false }
      }
    }));
    const config = loadMcpConfig(workdir);
    expect(config!.mcpServers.disabled.enabled).toBe(false);
  });

  test("enabled: true parses correctly", () => {
    const workdir = `${tmp.path}/enabled-true`;
    tmp.writeFile("enabled-true/.mcp.json", JSON.stringify({
      mcpServers: {
        active: { command: "echo", args: [], enabled: true }
      }
    }));
    const config = loadMcpConfig(workdir);
    expect(config!.mcpServers.active.enabled).toBe(true);
  });

  test("enabled absent: field is undefined", () => {
    const workdir = `${tmp.path}/enabled-absent`;
    tmp.writeFile("enabled-absent/.mcp.json", JSON.stringify({
      mcpServers: {
        normal: { command: "echo", args: [] }
      }
    }));
    const config = loadMcpConfig(workdir);
    expect(config!.mcpServers.normal.enabled).toBeUndefined();
  });
});

describe("interpolateEnv", () => {
  test("replaces ${VAR} with lookup value", () => {
    expect(interpolateEnv("hello ${NAME}", { NAME: "world" })).toBe("hello world");
  });

  test("replaces multiple vars in one string", () => {
    expect(interpolateEnv("${A}/${B}", { A: "x", B: "y" })).toBe("x/y");
  });

  test("missing var returns empty string", async () => {
    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      expect(interpolateEnv("${MISSING}", {})).toBe("");
      const warnRecord = buffer.find((r) => r.level === "warning");
      expect(warnRecord).toBeTruthy();
    } finally {
      await reset();
    }
  });

  test("no vars returns string unchanged", () => {
    expect(interpolateEnv("plain text", {})).toBe("plain text");
  });
});
