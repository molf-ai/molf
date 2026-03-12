import { resolve } from "path";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";

export const workerArgsSchema = z.object({
  name: z.string().min(1, "Worker name is required"),
  workdir: z
    .string()
    .default(process.cwd())
    .transform((p) => resolve(p)),
  "server-url": z.string().default("wss://127.0.0.1:7600"),
  token: z.string().optional(),
  "tls-ca": z.string().transform((p) => resolve(p)).optional(),
});

export function parseWorkerArgs(argv?: string[]) {
  return parseCli(
    {
      name: "molf-worker",
      version: "0.1.0",
      description: "Molf worker",
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
          default: "wss://127.0.0.1:7600",
          env: "MOLF_SERVER_URL",
        },
        token: {
          type: "string",
          short: "t",
          description: "Auth token or API key",
          env: "MOLF_TOKEN",
        },
        "tls-ca": {
          type: "string",
          description: "Path to trusted CA certificate PEM file",
          env: "MOLF_TLS_CA",
        },
      },
      schema: workerArgsSchema,
    },
    argv,
  );
}
