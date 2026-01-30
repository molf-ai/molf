import { resolve } from "path";
import { getBuiltinTools } from "@molf-ai/agent-core";
import { getOrCreateWorkerId } from "./identity.js";
import { loadSkills, loadAgentsDoc } from "./skills.js";
import { ToolExecutor } from "./tool-executor.js";
import { connectToServer } from "./connection.js";

function parseArgs(args: string[]): {
  name: string;
  workdir: string;
  serverUrl: string;
  token: string;
} {
  let name = "";
  let workdir = process.cwd();
  let serverUrl = process.env.MOLF_SERVER_URL ?? "ws://127.0.0.1:7600";
  let token = process.env.MOLF_TOKEN ?? "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name":
        name = args[++i] ?? "";
        break;
      case "--workdir":
        workdir = resolve(args[++i] ?? ".");
        break;
      case "--server-url":
        serverUrl = args[++i] ?? serverUrl;
        break;
      case "--token":
        token = args[++i] ?? token;
        break;
    }
  }

  if (!name) {
    console.error("Error: --name is required");
    process.exit(1);
  }

  if (!token) {
    console.error(
      "Error: --token or MOLF_TOKEN environment variable is required",
    );
    process.exit(1);
  }

  return { name, workdir: resolve(workdir), serverUrl, token };
}

async function main() {
  const { name, workdir, serverUrl, token } = parseArgs(process.argv.slice(2));

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

  // Load AGENTS.md
  const agentsDoc = loadAgentsDoc(workdir);
  if (agentsDoc) {
    console.log("Loaded AGENTS.md");
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
        agentsDoc: agentsDoc ?? undefined,
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
