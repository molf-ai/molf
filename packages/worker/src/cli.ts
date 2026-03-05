import { resolve } from "path";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";

export const workerArgsSchema = z.object({
  name: z.string().min(1, "Worker name is required"),
  workdir: z
    .string()
    .default(process.cwd())
    .transform((p) => resolve(p)),
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().min(1, "Auth token is required"),
});

export function parseWorkerArgs(argv?: string[]) {
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
