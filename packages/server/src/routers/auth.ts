import { getLogger } from "@logtape/logtape";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, authedProcedure, publicProcedure } from "../context.js";
import { generateApiKey, hashCredential, addApiKey, listApiKeys, revokeApiKey } from "../auth.js";

const logger = getLogger(["molf", "server", "auth"]);

export const authRouter = router({
  createPairingCode: authedProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(({ input, ctx }) => {
      const code = ctx.pairingStore.createCode(input.name);
      return { code };
    }),

  redeemPairingCode: publicProcedure
    .input(z.object({ code: z.string().length(6).regex(/^\d{6}$/) }))
    .mutation(({ input, ctx }) => {
      const ip = ctx.remoteIp ?? "unknown";

      // Rate limit check
      const rateResult = ctx.rateLimiter.check(ip);
      if (!rateResult.allowed) {
        logger.warn("Pairing redemption rate-limited", { ip, reason: rateResult.reason });
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many attempts. Try again later.",
        });
      }
      ctx.rateLimiter.record(ip);

      // Redeem
      const result = ctx.pairingStore.redeemCode(input.code);
      if (!result) {
        logger.warn("Pairing redemption failed", { ip });
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid or expired pairing code.",
        });
      }

      // Generate API key
      const apiKey = generateApiKey();
      const keyId = crypto.randomUUID();
      addApiKey(ctx.dataDir, {
        id: keyId,
        name: result.name,
        hash: hashCredential(apiKey),
        createdAt: Date.now(),
      });

      logger.info("Device paired", { name: result.name, keyId, ip });
      return { apiKey, name: result.name };
    }),

  listApiKeys: authedProcedure
    .query(({ ctx }) => {
      const keys = listApiKeys(ctx.dataDir);
      // Return without hashes
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      }));
    }),

  revokeApiKey: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input, ctx }) => {
      const revoked = revokeApiKey(ctx.dataDir, input.id);
      return { revoked };
    }),
});
