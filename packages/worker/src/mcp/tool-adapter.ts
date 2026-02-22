import { getLogger } from "@logtape/logtape";
import type { BinaryResult } from "@molf-ai/protocol";
import type { WorkerTool } from "../tool-executor.js";

const logger = getLogger(["molf", "worker", "mcp"]);

/** Content types returned by MCP callTool. */
interface McpTextContent {
  type: "text";
  text: string;
}

interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type McpContent = McpTextContent | McpImageContent | { type: string };

/** Minimal interface for calling tools on an MCP server. */
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content: McpContent[];
    isError?: boolean;
  }>;
}

/** Tool definition as returned by MCP listTools. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function base64ByteSize(b64: string): number {
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor(b64.length * 3 / 4) - padding;
}

function formatCallResult(content: McpContent[], path: string): unknown {
  if (!content || content.length === 0) {
    return "";
  }

  const texts: string[] = [];
  let lastImage: BinaryResult | undefined;

  for (const item of content) {
    if (item.type === "text") {
      texts.push((item as McpTextContent).text);
    } else if (item.type === "image") {
      const img = item as McpImageContent;
      lastImage = {
        type: "binary",
        data: img.data,
        mimeType: img.mimeType,
        path,
        size: base64ByteSize(img.data),
      };
    }
  }

  // If there's an image, return it as BinaryResult (text is secondary)
  if (lastImage) {
    return lastImage;
  }

  return texts.join("\n");
}

/**
 * Adapt MCP tool definitions into WorkerTool instances that can be registered
 * with the ToolExecutor. Each adapted tool delegates execution to the
 * McpToolCaller (backed by an MCP Client).
 */
export function adaptMcpTools(
  serverName: string,
  tools: McpToolDef[],
  caller: McpToolCaller,
): WorkerTool[] {
  const sanitizedServer = sanitizeName(serverName);
  const seen = new Set<string>();

  return tools.flatMap((tool) => {
    const sanitizedTool = sanitizeName(tool.name);
    const qualifiedName = `${sanitizedServer}_${sanitizedTool}`;

    if (seen.has(qualifiedName)) {
      logger.warn("Tool name collision, skipping duplicate", { qualifiedName, serverName });
      return [];
    }
    seen.add(qualifiedName);

    return {
      name: qualifiedName,
      description: `[${serverName}] ${tool.description ?? ""}`,
      inputSchema: Object.assign(
        { type: "object" as const, additionalProperties: false },
        tool.inputSchema ?? {},
      ),
      execute: async (args: Record<string, unknown>) => {
        const result = await caller.callTool(tool.name, args);

        if (result.isError) {
          const errorText = (result.content ?? [])
            .filter((c): c is McpTextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          throw new Error(errorText || "MCP tool returned an error");
        }

        return formatCallResult(result.content, `mcp://${serverName}/${tool.name}`);
      },
    };
  });
}
