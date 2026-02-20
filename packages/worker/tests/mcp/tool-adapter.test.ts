import { describe, test, expect, spyOn } from "bun:test";
import { adaptMcpTools, sanitizeName, type McpToolCaller, type McpToolDef } from "../../src/mcp/tool-adapter.js";

/**
 * Stub McpToolCaller — plain object that satisfies the interface.
 * No mock.module() needed since adaptMcpTools accepts the caller as a parameter.
 */
function createMockCaller(
  callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<any>,
): McpToolCaller {
  return {
    callTool: callToolImpl ?? (async () => ({ content: [] })),
  };
}

function createStaticCaller(result: unknown, shouldReject?: Error): McpToolCaller {
  return createMockCaller(async () => {
    if (shouldReject) throw shouldReject;
    return result;
  });
}

const simpleTool: McpToolDef = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object" },
};

describe("adaptMcpTools — naming", () => {
  test("correct naming: server + tool joined with underscore", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("my-server", [simpleTool], caller);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("my-server_read_file");
  });

  test("special chars in server name are sanitized to underscore", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("my.server", [simpleTool], caller);

    expect(tools[0].name).toBe("my_server_read_file");
  });

  test("hyphens in tool name are preserved", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("server", [
      { name: "read-file", description: "Read", inputSchema: { type: "object" } },
    ], caller);

    expect(tools[0].name).toBe("server_read-file");
  });
});

describe("adaptMcpTools — description", () => {
  test("description prefixed with [serverName]", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("my-server", [simpleTool], caller);

    expect(tools[0].description).toBe("[my-server] Read a file");
  });
});

describe("adaptMcpTools — input schema", () => {
  test("type is always 'object' and original properties preserved", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("srv", [
      {
        name: "tool",
        description: "A tool",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
          },
        },
      },
    ], caller);

    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      path: { type: "string" },
      recursive: { type: "boolean" },
    });
  });

  test("when MCP schema has no type, still gets type 'object'", () => {
    const caller = createStaticCaller({ content: [] });
    // Cast to bypass TS check — simulates a real MCP server that omits type
    const toolDef = {
      name: "tool",
      description: "A tool",
      inputSchema: {
        properties: { query: { type: "string" } },
      },
    } as McpToolDef;

    const tools = adaptMcpTools("srv", [toolDef], caller);

    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({ query: { type: "string" } });
  });
});

describe("adaptMcpTools — execute result formatting", () => {
  test("text result: single content item returns string", async () => {
    const caller = createStaticCaller({
      content: [{ type: "text", text: "hello" }],
    });
    const tools = adaptMcpTools("srv", [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ], caller);

    const output = await tools[0].execute!({});
    expect(output).toBe("hello");
  });

  test("multiple text items are joined with newline", async () => {
    const caller = createStaticCaller({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    const tools = adaptMcpTools("srv", [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ], caller);

    const output = await tools[0].execute!({});
    expect(output).toBe("line one\nline two");
  });

  test("image result returns BinaryResult with correct byte count", async () => {
    // "AQID" is base64 for bytes [1,2,3] (3 bytes, no padding)
    // Math.ceil(4 * 3 / 4) = 3
    const base64Data = "AQID";
    const caller = createStaticCaller({
      content: [{ type: "image", data: base64Data, mimeType: "image/png" }],
    });
    const tools = adaptMcpTools("srv", [
      { name: "screenshot", description: "Take screenshot", inputSchema: { type: "object" } },
    ], caller);

    const output = (await tools[0].execute!({})) as any;
    expect(output.type).toBe("binary");
    expect(output.data).toBe(base64Data);
    expect(output.mimeType).toBe("image/png");
    expect(output.size).toBe(3);
    expect(output.path).toBe("mcp://srv/screenshot");
  });

  test("image result byte count accounts for padding", async () => {
    // "SGVsbG8gV29ybGQ=" is base64 for "Hello World" (11 bytes, 1 padding char)
    // base64 length: 16. floor(16 * 3 / 4) - 1 padding = 11
    const base64Data = "SGVsbG8gV29ybGQ=";
    const caller = createStaticCaller({
      content: [{ type: "image", data: base64Data, mimeType: "image/png" }],
    });
    const tools = adaptMcpTools("srv", [
      { name: "img", description: "Image", inputSchema: { type: "object" } },
    ], caller);

    const output = (await tools[0].execute!({})) as any;
    expect(output.type).toBe("binary");
    expect(output.size).toBe(11); // "Hello World" is exactly 11 bytes
    expect(output.path).toBe("mcp://srv/img");
  });

  test("image result byte count with double padding", async () => {
    // "AQ==" is base64 for byte [1] (1 byte, 2 padding chars)
    // base64 length: 4. floor(4 * 3 / 4) - 2 padding = 1
    const base64Data = "AQ==";
    const caller = createStaticCaller({
      content: [{ type: "image", data: base64Data, mimeType: "image/png" }],
    });
    const tools = adaptMcpTools("srv", [
      { name: "img", description: "Image", inputSchema: { type: "object" } },
    ], caller);

    const output = (await tools[0].execute!({})) as any;
    expect(output.type).toBe("binary");
    expect(output.size).toBe(1);
    expect(output.path).toBe("mcp://srv/img");
  });

  test("mixed content: text + image returns last image as BinaryResult", async () => {
    const base64Data = "AQID";
    const caller = createStaticCaller({
      content: [
        { type: "text", text: "Some text info" },
        { type: "image", data: base64Data, mimeType: "image/jpeg" },
      ],
    });
    const tools = adaptMcpTools("srv", [
      { name: "render", description: "Render", inputSchema: { type: "object" } },
    ], caller);

    const output = (await tools[0].execute!({})) as any;
    expect(output.type).toBe("binary");
    expect(output.data).toBe(base64Data);
    expect(output.mimeType).toBe("image/jpeg");
    expect(output.size).toBe(3);
    expect(output.path).toBe("mcp://srv/render");
  });

  test("isError: true with text throws Error with that text as message", async () => {
    const caller = createStaticCaller({
      content: [{ type: "text", text: "Something went wrong" }],
      isError: true,
    });
    const tools = adaptMcpTools("srv", [
      { name: "fail", description: "Fail", inputSchema: { type: "object" } },
    ], caller);

    await expect(tools[0].execute!({})).rejects.toThrow("Something went wrong");
  });

  test("caller.callTool rejection propagates", async () => {
    const error = new Error("Connection lost");
    const caller = createStaticCaller(undefined, error);
    const tools = adaptMcpTools("srv", [
      { name: "tool", description: "Tool", inputSchema: { type: "object" } },
    ], caller);

    await expect(tools[0].execute!({})).rejects.toThrow("Connection lost");
  });
});

describe("adaptMcpTools — additionalProperties", () => {
  test("additionalProperties: false is set on adapted schema", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("srv", [simpleTool], caller);
    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
  });

  test("additionalProperties: false overrides if schema had additionalProperties: true", () => {
    const caller = createStaticCaller({ content: [] });
    const toolWithAdditional: McpToolDef = {
      name: "tool",
      description: "Tool",
      inputSchema: { type: "object", additionalProperties: true },
    };
    const tools = adaptMcpTools("srv", [toolWithAdditional], caller);
    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("adaptMcpTools — collision detection", () => {
  test("duplicate qualifiedName within same server: warning logged, duplicate dropped", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("srv", [
      { name: "tool", description: "First", inputSchema: { type: "object" } },
      { name: "tool", description: "Second", inputSchema: { type: "object" } },
    ], caller);
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("[srv] First");
  });

  test("collision warning is logged", () => {
    const warnSpy = spyOn(console, "warn");
    const caller = createStaticCaller({ content: [] });
    adaptMcpTools("srv", [
      { name: "tool", description: "First", inputSchema: { type: "object" } },
      { name: "tool", description: "Second", inputSchema: { type: "object" } },
    ], caller);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collision"));
    warnSpy.mockRestore();
  });

  test("different tool names: both kept", () => {
    const caller = createStaticCaller({ content: [] });
    const tools = adaptMcpTools("srv", [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } },
    ], caller);
    expect(tools).toHaveLength(2);
  });
});

describe("sanitizeName — exported", () => {
  test("dots/spaces/slashes are replaced with underscore", () => {
    expect(sanitizeName("my.server")).toBe("my_server");
    expect(sanitizeName("my server")).toBe("my_server");
    expect(sanitizeName("my/server")).toBe("my_server");
  });

  test("hyphens and underscores are preserved", () => {
    expect(sanitizeName("my-server")).toBe("my-server");
    expect(sanitizeName("my_server")).toBe("my_server");
  });

  test("empty string returns empty string", () => {
    expect(sanitizeName("")).toBe("");
  });
});
