import { resolve } from "path";
import { z } from "zod";
import { parseCli, errorMessage } from "@molf-ai/protocol";
import { getBuiltinWorkerTools } from "./tools/index.js";
import { getOrCreateWorkerId } from "./identity.js";
import { loadSkills, loadAgentsDoc } from "./skills.js";
import { ToolExecutor } from "./tool-executor.js";
import { connectToServer } from "./connection.js";
import { loadMcpTools, enforceToolLimit, adaptMcpTools, createServerCaller, sanitizeName } from "./mcp/index.js";

const workerArgsSchema = z.object({
  name: z.string().min(1, "Worker name is required"),
  workdir: z
    .string()
    .default(process.cwd())
    .transform((p) => resolve(p)),
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().min(1, "Auth token is required"),
});

function parseWorkerArgs(argv?: string[]) {
  return parseCli(
    {
      name: "molf-worker",
      version: "0.1.0",
      description: "Molf worker",
      usage: "bun run dev:worker -- --name <name> [options]",
      options: {
        name: {
          type: "string",
          short: "n",
          description: "Worker name",
          required: true,
        },
        workdir: {
          type: "string",
          short: "w",
          description: "Working directory",
          default: process.cwd(),
        },
        "server-url": {
          type: "string",
          short: "s",
          description: "WebSocket server URL",
          default: "ws://127.0.0.1:7600",
          env: "MOLF_SERVER_URL",
        },
        token: {
          type: "string",
          short: "t",
          description: "Auth token",
          required: true,
          env: "MOLF_TOKEN",
        },
      },
      schema: workerArgsSchema,
    },
    argv,
  );
}

async function main() {
  const args = parseWorkerArgs();
  const { name, workdir, token } = args;
  const serverUrl = args["server-url"];

  console.log(`Molf Worker: ${name}`);
  console.log(`Workdir: ${workdir}`);
  console.log(`Server: ${serverUrl}`);

  // Get or create persistent worker ID
  const workerId = getOrCreateWorkerId(workdir);
  console.log(`Worker ID: ${workerId}`);

  // Load tools
  const toolExecutor = new ToolExecutor(workdir);
  toolExecutor.registerTools(getBuiltinWorkerTools());

  // Load skills
  const skills = loadSkills(workdir);
  if (skills.length > 0) {
    console.log(`Loaded ${skills.length} skills: ${skills.map((s) => s.name).join(", ")}`);
  }

  // Load instruction doc (AGENTS.md or CLAUDE.md)
  const agentsDoc = loadAgentsDoc(workdir);
  if (agentsDoc) {
    console.log(`Loaded ${agentsDoc.source}`);
  }

  // Load MCP tools (async) — after skills so tool count is accurate
  const { tools: mcpTools, manager: mcpManager } = await loadMcpTools(workdir);
  if (mcpTools.length > 0) {
    const allowed = enforceToolLimit(toolExecutor.getToolInfos().length, mcpTools);
    if (allowed.length > 0) {
      toolExecutor.registerTools(allowed);
      mcpManager!.registerExitHandler();
      console.log(`Loaded ${allowed.length} MCP tools from ${mcpManager!.getConnectedServers().length} servers`);
    }
  }

  // Feature 5: reload tools when a server sends ToolListChanged or reconnects
  if (mcpManager) {
    mcpManager.onToolsChanged = async (serverName) => {
      console.log(`MCP: '${serverName}' tools changed, reloading...`);
      try {
        const mcpToolDefs = await mcpManager.listTools(serverName);
        const caller = createServerCaller(mcpManager, serverName);
        const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);

        const newNames = new Set(adapted.map((t) => t.name));
        const prefix = `${sanitizeName(serverName)}_`;
        const toRemove = toolExecutor.getToolNames()
          .filter((n) => n.startsWith(prefix) && !newNames.has(n));

        if (toRemove.length > 0) {
          toolExecutor.deregisterTools(toRemove);
          console.log(`MCP: removed ${toRemove.length} stale tools from '${serverName}': ${toRemove.join(", ")}`);
        }
        const currentCount = toolExecutor.getToolInfos().length;
        const allowed = enforceToolLimit(currentCount, adapted);
        if (allowed.length > 0) {
          toolExecutor.registerTools(allowed);
        }
        console.log(`MCP: reloaded ${allowed.length} tools from '${serverName}'`);
      } catch (err) {
        console.warn(`MCP: failed to reload tools from '${serverName}': ${err}`);
      }
    };
  }

  // Connect to server
  try {
    const connection = await connectToServer({
      serverUrl,
      token,
      workerId,
      name,
      workdir,
      toolExecutor,
      skills,
      metadata: {
        workdir,
        agentsDoc: agentsDoc?.content,
      },
    });

    console.log("Connected and ready for tool calls.\n");

    // Keep process alive
    process.on("SIGINT", () => {
      console.log("\nDisconnecting...");
      connection.close();
      if (mcpManager) {
        mcpManager.closeAll().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      } else {
        process.exit(0);
      }
    });

    process.on("SIGTERM", () => {
      connection.close();
      if (mcpManager) {
        mcpManager.closeAll().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      } else {
        process.exit(0);
      }
    });
  } catch (err) {
    console.error(
      "Failed to connect to server:",
      errorMessage(err),
    );
    if (mcpManager) {
      await mcpManager.closeAll();
    }
    process.exit(1);
  }
}

main();
