import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";
import {
  fsReadInput,
  fsReadOutput,
  errorMessage,
} from "@molf-ai/protocol";
import type { FsReadRequest } from "@molf-ai/protocol";

export const fsRouter = router({
  read: authedProcedure
    .input(fsReadInput)
    .output(fsReadOutput)
    .mutation(async ({ input, ctx }) => {
      // 1. Load session -> get workerId
      const session = loadSessionOrThrow(ctx.sessionMgr, input.sessionId);

      // 2. Verify worker is connected
      const worker = ctx.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker not connected" });
      }

      // 3. Dispatch fs read request via FsDispatch (30s timeout built into FsDispatch)
      const request: FsReadRequest = {
        requestId: `fs_${crypto.randomUUID().slice(0, 8)}`,
        outputId: input.outputId,
        path: input.path,
      };

      let result;
      try {
        result = await ctx.fsDispatch.dispatch(session.workerId, request);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          throw new TRPCError({ code: "TIMEOUT", message: "File read timed out" });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMessage(err) });
      }

      if (result.error) {
        if (result.error.toLowerCase().includes("disconnect")) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.error });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
      }

      return {
        content: result.content,
        size: result.size,
        encoding: result.encoding,
      };
    }),
});
