import { resolve } from "path";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";
import { getBuiltinTools } from "@molf-ai/agent-core";
import { getOrCreateWorkerId } from "./identity.js";
import { loadSkills, loadAgentsDoc } from "./skills.js";
import { ToolExecutor } from "./tool-executor.js";
import { connectToServer } from "./connection.js";

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
  const toolExecutor = new ToolExecutor();
  toolExecutor.registerTools(getBuiltinTools());

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

  // Connect to server
  try {
    const connection = await connectToServer({
      serverUrl,
      token,
      workerId,
      name,
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
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      connection.close();
      process.exit(0);
    });
  } catch (err) {
    console.error(
      "Failed to connect to server:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

main();
