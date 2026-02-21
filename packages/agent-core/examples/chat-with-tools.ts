import { tool } from "ai";
import { z } from "zod";
import { Agent } from "../src/index.js";

const agent = new Agent({
  llm: { provider: "gemini", model: "gemini-2.5-flash" },
  behavior: {
    systemPrompt:
      "You are a helpful assistant with access to tools. Use them when appropriate.",
    maxSteps: 5,
  },
});

// Register a calculator tool
agent.registerTool("calculate", tool({
  description:
    "Evaluate a mathematical expression and return the result. Supports basic arithmetic.",
  inputSchema: z.object({
    expression: z
      .string()
      .describe("Mathematical expression to evaluate, e.g. '2 + 3 * 4'"),
  }),
  execute: async ({ expression }) => {
    // Simple and safe evaluation for demo purposes
    const sanitized = expression.replace(/[^0-9+\-*/.() ]/g, "");
    try {
      const result = new Function(`return (${sanitized})`)();
      return { result: Number(result) };
    } catch {
      return { error: "Invalid expression" };
    }
  },
}));

// Register a current time tool
agent.registerTool("get_current_time", tool({
  description: "Get the current date and time.",
  inputSchema: z.object({}),
  execute: async () => {
    return { time: new Date().toISOString() };
  },
}));

agent.onEvent((event) => {
  switch (event.type) {
    case "content_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_call_start":
      console.log(`\n[Tool Call: ${event.toolName}(${event.arguments})]`);
      break;
    case "tool_call_end":
      console.log(`[Tool Result: ${event.result}]`);
      break;
    case "turn_complete":
      process.stdout.write("\n--- Turn Complete ---\n");
      break;
    case "error":
      console.error("\nError:", event.error.message);
      break;
  }
});

const prompt =
  process.argv[2] ?? "What is 42 * 17 + 3? Also, what time is it?";
console.log(`> ${prompt}\n`);

try {
  await agent.prompt(prompt);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}
