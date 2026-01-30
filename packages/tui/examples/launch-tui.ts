import React from "react";
import { render } from "ink";
import { z } from "zod";
import { App } from "../src/app.js";
import type { AgentToolDefinition } from "@molf-ai/agent-core";

const tools: AgentToolDefinition[] = [
  {
    name: "calculate",
    description: "Evaluate a mathematical expression.",
    inputSchema: z.object({
      expression: z.string().describe("Math expression to evaluate"),
    }),
    execute: async (args: unknown) => {
      const { expression } = args as { expression: string };
      const sanitized = expression.replace(/[^0-9+\-*/.() ]/g, "");
      try {
        const result = new Function(`return (${sanitized})`)();
        return { result: Number(result) };
      } catch {
        return { error: "Invalid expression" };
      }
    },
  },
  {
    name: "get_current_time",
    description: "Get the current date and time.",
    inputSchema: z.object({}),
    execute: async () => ({ time: new Date().toISOString() }),
  },
];

render(
  React.createElement(App, {
    config: {
      behavior: {
        systemPrompt:
          "You are Molf, a helpful assistant. You have access to a calculator and a clock.",
      },
    },
    tools,
  }),
);
