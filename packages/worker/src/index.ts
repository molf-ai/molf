import { resolve } from "path";
import { mkdirSync } from "fs";
import { z } from "zod";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";
import { parseCli, errorMessage } from "@molf-ai/protocol";
import { getBuiltinWorkerTools } from "./tools/index.js";
import { getOrCreateWorkerId } from "./identity.js";
import { loadSkills, loadAgentsDoc } from "./skills.js";
import { ToolExecutor } from "./tool-executor.js";
import { connectToServer } from "./connection.js";
import { loadMcpTools, enforceToolLimit, adaptMcpTools, createServerCaller, sanitizeName } from "./mcp/index.js";
import { StateWatcher } from "./state-watcher.js";

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

  // Configure LogTape logging
  const logLevel = (process.env.MOLF_LOG_LEVEL ?? "info") as "debug" | "info" | "warning" | "error";
  const disableFileLog = process.env.MOLF_LOG_FILE === "none";

  const sinks: Record<string, ReturnType<typeof getConsoleSink>> = {
    console: getConsoleSink({ formatter: getPrettyFormatter({ timestamp: "rfc3339", wordWrap: false, categoryWidth: 18, properties: true }) }),
  };
  const sinkNames: string[] = ["console"];

  if (!disableFileLog) {
    const logDir = resolve(workdir, ".molf", "logs");
    mkdirSync(logDir, { recursive: true });
    (sinks as Record<string, unknown>).file = getRotatingFileSink(resolve(logDir, "worker.log"), {
      formatter: jsonLinesFormatter,
      maxSize: 5 * 1024 * 1024,
      maxFiles: 5,
    });
    sinkNames.push("file");
  }

  await configure({
    sinks,
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: sinkNames },
      { category: ["molf"], lowestLevel: logLevel, sinks: sinkNames },
    ],
  });

  const logger = getLogger(["molf", "worker"]);

  // Get or create persistent worker ID
  const workerId = getOrCreateWorkerId(workdir);
  logger.info("Molf Worker started", { name, workdir, serverUrl, workerId });

  // Load tools
  const toolExecutor = new ToolExecutor(workdir);
  toolExecutor.registerTools(getBuiltinWorkerTools());

  const mcpLogger = getLogger(["molf", "worker", "mcp"]);

  // Load skills
  const { skills, source: skillsSource } = loadSkills(workdir);
  if (skills.length > 0) {
    logger.info("Loaded skills", { skillCount: skills.length, source: skillsSource, skillNames: skills.map((s) => s.name).join(", ") });
  }

  // Load instruction doc (AGENTS.md or CLAUDE.md)
  const agentsDoc = loadAgentsDoc(workdir);
  if (agentsDoc) {
    logger.info("Loaded instruction doc", { source: agentsDoc.source });
  }

  // Load MCP tools (async) — after skills so tool count is accurate
  const { tools: mcpTools, manager: mcpManager } = await loadMcpTools(workdir);
  if (mcpTools.length > 0) {
    const allowed = enforceToolLimit(toolExecutor.getToolInfos().length, mcpTools);
    if (allowed.length > 0) {
      toolExecutor.registerTools(allowed);
      mcpManager!.registerExitHandler();
      mcpLogger.info("Loaded MCP tools", { toolCount: allowed.length, serverCount: mcpManager!.getConnectedServers().length });
    }
  }

  // Feature 5: reload tools when a server sends ToolListChanged or reconnects
  if (mcpManager) {
    mcpManager.onToolsChanged = async (serverName) => {
      mcpLogger.debug("Tools changed, reloading", { serverName });
      try {
        const mcpToolDefs = await mcpManager.listTools(serverName);
        const caller = createServerCaller(mcpManager, serverName);
        const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);

        const newNames = new Set(adapted.map((t) => t.name));
        const prefix = `${sanitizeName(serverName)}_`;
        const toRemove = toolExecutor.getToolNames()
          .filter((n) => n.startsWith(prefix) && !newNames.has(n));

        let removedCount = 0;
        if (toRemove.length > 0) {
          toolExecutor.deregisterTools(toRemove);
          removedCount = toRemove.length;
          mcpLogger.debug("Removed stale tools", { count: toRemove.length, serverName, tools: toRemove.join(", ") });
        }
        const currentCount = toolExecutor.getToolInfos().length;
        const allowed = enforceToolLimit(currentCount, adapted);
        if (allowed.length > 0) {
          toolExecutor.registerTools(allowed);
        }
        mcpLogger.info("MCP tools reloaded", { toolCount: allowed.length, serverName, removedCount });
      } catch (err) {
        mcpLogger.warn("Failed to reload tools", { serverName, error: err });
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

    logger.info("Connected and ready for tool calls.");

    // Start filesystem watchers for hot-reload
    const stateWatcher = new StateWatcher({
      workdir,
      toolExecutor,
      mcpManager,
      syncState: (state) => connection.syncState(state),
    });
    stateWatcher.start();
    logger.info("File watchers started (skills, MCP config, project instructions)");

    // Keep process alive
    process.on("SIGINT", () => {
      logger.info("Disconnecting...");
      stateWatcher.close();
      connection.close();
      if (mcpManager) {
        mcpManager.closeAll().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      } else {
        process.exit(0);
      }
    });

    process.on("SIGTERM", () => {
      stateWatcher.close();
      connection.close();
      if (mcpManager) {
        mcpManager.closeAll().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      } else {
        process.exit(0);
      }
    });
  } catch (err) {
    logger.error("Failed to connect to server", { reason: errorMessage(err), error: err });
    if (mcpManager) {
      await mcpManager.closeAll();
    }
    process.exit(1);
  }
}

main();
