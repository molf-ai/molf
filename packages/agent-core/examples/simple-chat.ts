import { Agent } from "../src/index.js";

const agent = new Agent({
  llm: { provider: "gemini", model: "gemini-2.5-flash" },
  behavior: { systemPrompt: "You are a helpful assistant. Be concise." },
});

agent.onEvent((event) => {
  switch (event.type) {
    case "content_delta":
      process.stdout.write(event.delta);
      break;
    case "status_change":
      if (event.status === "streaming") {
        process.stdout.write("\n--- Streaming ---\n");
      }
      break;
    case "turn_complete":
      process.stdout.write("\n--- Turn Complete ---\n");
      break;
    case "error":
      console.error("\nError:", event.error.message);
      break;
  }
});

const prompt = process.argv[2] ?? "What is the capital of France?";
console.log(`> ${prompt}\n`);

try {
  await agent.prompt(prompt);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}
