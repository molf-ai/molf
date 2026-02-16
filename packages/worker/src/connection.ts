import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "@trpc/client";
import type { AppRouter } from "@molf-ai/protocol";
import type { WorkerToolInfo, WorkerSkillInfo } from "@molf-ai/protocol";
import type { ToolExecutor } from "./tool-executor.js";
import { saveUploadedFile } from "./uploads.js";

export interface WorkerConnectionOptions {
  serverUrl: string;
  token: string;
  workerId: string;
  name: string;
  workdir: string;
  toolExecutor: ToolExecutor;
  skills: WorkerSkillInfo[];
  metadata?: Record<string, unknown>;
}

export async function connectToServer(
  opts: WorkerConnectionOptions,
): Promise<{ close: () => void }> {
  const { serverUrl, token, workerId, name, workdir, toolExecutor, skills, metadata } =
    opts;

  // Create WebSocket client with auth params
  const url = new URL(serverUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("clientId", workerId);
  url.searchParams.set("name", name);

  const wsClient = createWSClient({
    url: url.toString(),
  });

  const trpc = createTRPCClient<AppRouter>({
    links: [
      wsLink({
        client: wsClient,
      }),
    ],
  });

  // Register with server
  const toolInfos = toolExecutor.getToolInfos();
  console.log(
    `Registering worker "${name}" (${workerId}) with ${toolInfos.length} tools, ${skills.length} skills`,
  );

  await trpc.worker.register.mutate({
    workerId,
    name,
    tools: toolInfos,
    skills,
    metadata,
  });

  console.log(`Worker registered successfully.`);

  // Subscribe to tool calls
  const toolSub = trpc.worker.onToolCall.subscribe(
    { workerId },
    {
      onData: async (request) => {
        console.log(
          `Tool call: ${request.toolName} (${request.toolCallId})`,
        );

        const { result, error } = await toolExecutor.execute(
          request.toolName,
          request.args,
        );

        await trpc.worker.toolResult.mutate({
          toolCallId: request.toolCallId,
          result,
          error,
        });
      },
      onError: (err) => {
        console.error("Tool call subscription error:", err);
      },
    },
  );

  // Subscribe to upload requests
  const uploadSub = trpc.worker.onUpload.subscribe({ workerId }, {
    onData: async (request) => {
      console.log(`Upload: ${request.filename} (${request.uploadId})`);

      try {
        const buffer = Buffer.from(request.data, "base64");
        const { path, size } = await saveUploadedFile(workdir, buffer, request.filename);

        await trpc.worker.uploadResult.mutate({
          uploadId: request.uploadId,
          path,
          size,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Upload failed: ${message}`);
        await trpc.worker.uploadResult.mutate({
          uploadId: request.uploadId,
          path: "",
          size: 0,
          error: message,
        });
      }
    },
    onError: (err) => {
      console.error("Upload subscription error:", err);
    },
  });

  return {
    close: () => {
      toolSub.unsubscribe();
      uploadSub.unsubscribe();
      wsClient.close();
    },
  };
}
