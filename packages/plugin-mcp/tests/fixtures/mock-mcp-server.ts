#!/usr/bin/env bun
/**
 * Minimal MCP server for integration tests.
 * Reads newline-delimited JSON-RPC 2.0 from stdin.
 * Responds to: initialize, initialized, tools/list, tools/call.
 * Exposes 2 tools: echo (returns input as text) and add (sums two numbers).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes input back",
      inputSchema: {
        type: "object" as const,
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Sums two numbers",
      inputSchema: {
        type: "object" as const,
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "echo") {
    return {
      content: [{ type: "text" as const, text: String(args?.message ?? "") }],
    };
  }

  if (name === "add") {
    const a = Number(args?.a ?? 0);
    const b = Number(args?.b ?? 0);
    return {
      content: [{ type: "text" as const, text: String(a + b) }],
    };
  }

  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});


const transport = new StdioServerTransport();
await server.connect(transport);
