import { initTRPC } from "@trpc/server";

export interface TRPCContext {
  token: string | null;
  clientId: string | null;
}

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
