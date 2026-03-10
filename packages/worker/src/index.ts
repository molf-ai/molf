import { resolve } from "path";
import { mkdirSync } from "fs";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";
import { errorMessage, HookRegistry, loadCredential } from "@molf-ai/protocol";
import { getBuiltinWorkerTools } from "./tools/index.js";
import { getOrCreateWorkerId } from "./identity.js";
import { loadSkills, loadAgentsDoc } from "./skills.js";
import { loadAgents } from "./agents.js";
import { ToolExecutor } from "./tool-executor.js";
import { connectToServer } from "./connection.js";
import { StateWatcher } from "./state-watcher.js";
import { SyncCoordinator } from "./sync-coordinator.js";
import { parseWorkerArgs } from "./cli.js";
import { runPairFlow } from "./pair.js";
import { WorkerPluginLoader } from "./plugin-loader.js";

async function main() {
  const args = parseWorkerArgs();
  const { name, workdir } = args;
  const serverUrl = args["server-url"];

  // Resolve token: CLI/env → credentials.json → auto-pair
  let token = args.token
    ?? loadCredential(serverUrl)?.apiKey
    ?? undefined;

  if (!token) {
    token = await runPairFlow(serverUrl, name);
  }

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

  // Initialize hook registry for plugin system
  const hookRegistry = new HookRegistry();
  const hookLogger = { warn: (msg: string, props?: Record<string, unknown>) => logger.warn(msg, props) };

  // Load tools
  const toolExecutor = new ToolExecutor(workdir);
  toolExecutor.setHookRegistry(hookRegistry, hookLogger);
  toolExecutor.registerTools(getBuiltinWorkerTools());

  // Load skills
  const { skills, source: skillsSource } = loadSkills(workdir);
  if (skills.length > 0) {
    logger.info("Loaded skills", { skillCount: skills.length, source: skillsSource, skillNames: skills.map((s) => s.name).join(", ") });
  }

  // Load agents
  const { agents, source: agentsSource } = loadAgents(workdir);
  if (agents.length > 0) {
    logger.info("Loaded agents", { agentCount: agents.length, source: agentsSource, agentNames: agents.map((a) => a.name).join(", ") });
  }

  // Load instruction doc (AGENTS.md or CLAUDE.md)
  const agentsDoc = loadAgentsDoc(workdir);
  if (agentsDoc) {
    logger.info("Loaded instruction doc", { source: agentsDoc.source });
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
      agents,
      metadata: {
        workdir,
        agentsDoc: agentsDoc?.content,
      },
    });

    logger.info("Connected and ready for tool calls.");

    // Mutable state that SyncCoordinator reads at send time
    let currentAgentsDoc = agentsDoc?.content;

    const syncCoordinator = new SyncCoordinator(
      {
        tools: () => toolExecutor.getToolInfos(),
        skills: () => skills,
        agents: () => agents,
        metadata: () => ({ workdir, agentsDoc: currentAgentsDoc }),
      },
      connection,
    );

    // Initialize plugin loader
    const pluginLoader = new WorkerPluginLoader(
      hookRegistry,
      toolExecutor,
      skills,
      agents,
      workdir,
    );

    // Wire syncState before loadPlugins — stored fn applies to subsequently loaded plugins too
    pluginLoader.setSyncStateFn(() => syncCoordinator.requestSync());

    // Load plugins if the server provided a list
    if (connection.pluginList && connection.pluginList.length > 0) {
      await pluginLoader.loadPlugins(connection.pluginList);
      const loaded = pluginLoader.getLoadedPluginNames();
      if (loaded.length > 0) {
        logger.info("Plugins loaded", { plugins: loaded.join(", ") });
      }
    }

    // Dispatch worker_start hook
    hookRegistry.dispatchObserving("worker_start", { workerId, workdir }, hookLogger);

    // Start filesystem watchers for hot-reload
    const stateWatcher = new StateWatcher({
      workdir,
      onSkillsChange: (newSkills) => { skills.length = 0; skills.push(...newSkills); },
      onAgentsChange: (newAgents) => { agents.length = 0; agents.push(...newAgents); },
      onAgentsDocChange: (doc) => { currentAgentsDoc = doc; },
      requestSync: () => syncCoordinator.requestSync(),
    });
    stateWatcher.start();
    logger.info("File watchers started (skills, project instructions)");

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info`${signal} received, disconnecting...`;
      hookRegistry.dispatchObserving("worker_stop", {}, hookLogger);
      await pluginLoader.destroyAll();
      await stateWatcher.close();
      connection.close();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    logger.error("Failed to connect to server", { reason: errorMessage(err), error: err });
    process.exit(1);
  }
}

main();
