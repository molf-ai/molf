import { Agent } from "../src/index.js";
import {
  shellExecTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
} from "../../worker/src/tools/index.js";

const agent = new Agent({
  llm: { provider: "gemini", model: "gemini-2.5-flash" },
  behavior: {
    systemPrompt:
      "You are Molf, a helpful AI assistant running in a terminal. " +
      "You have access to tools for shell commands and file operations. " +
      "Use tools proactively when they would help answer the user's request. " +
      "Be direct and helpful.",
    maxSteps: 5,
  },
});

// Register all built-in tools
agent.registerTools({
  shell_exec: shellExecTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  glob: globTool,
  grep: grepTool,
});

agent.onEvent((event) => {
  switch (event.type) {
    case "content_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_call_start":
      console.log(`\n[Tool: ${event.toolName}(${event.arguments})]`);
      break;
    case "tool_call_end":
      console.log(`[Result: ${event.result.slice(0, 200)}${event.result.length > 200 ? "..." : ""}]`);
      break;
    case "turn_complete":
      process.stdout.write("\n--- Done ---\n");
      break;
    case "error":
      console.error("\nError:", event.error.message);
      break;
  }
});

const prompt =
  process.argv[2] ??
  "List the files in the current directory and then read the package.json file.";
console.log(`> ${prompt}\n`);

try {
  await agent.prompt(prompt);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}
