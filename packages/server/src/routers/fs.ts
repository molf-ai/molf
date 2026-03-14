import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";
import { errorMessage } from "@molf-ai/protocol";
import type { FsReadRequest } from "@molf-ai/protocol";

export const fsHandlers = {
  read: os.fs.read
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);

      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker not connected" });
      }

      const request: FsReadRequest = {
        requestId: `fs_${crypto.randomUUID().slice(0, 8)}`,
        outputId: input.outputId,
        path: input.path,
      };

      let result;
      try {
        result = await context.fsDispatch.dispatch(session.workerId, request);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          throw new ORPCError("TIMEOUT", { message: "File read timed out" });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(err) });
      }

      if (result.error) {
        if (result.error.toLowerCase().includes("disconnect")) {
          throw new ORPCError("PRECONDITION_FAILED", { message: result.error });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: result.error });
      }

      return {
        content: result.content,
        size: result.size,
        encoding: result.encoding,
      };
    }),
};
