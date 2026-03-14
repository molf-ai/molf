import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { generateApiKey, hashCredential, addApiKey, listApiKeys, revokeApiKey } from "../auth.js";

const logger = getLogger(["molf", "server", "auth"]);

export const authHandlers = {
  createPairingCode: os.auth.createPairingCode
    .use(authMiddleware)
    .handler(({ input, context }) => {
      const code = context.pairingStore.createCode(input.name);
      return { code };
    }),

  redeemPairingCode: os.auth.redeemPairingCode
    .handler(({ input, context }) => {
      const ip = context.remoteIp ?? "unknown";

      const rateResult = context.rateLimiter.check(ip);
      if (!rateResult.allowed) {
        logger.warn("Pairing redemption rate-limited", { ip, reason: rateResult.reason });
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "Too many attempts. Try again later.",
        });
      }
      context.rateLimiter.record(ip);

      const result = context.pairingStore.redeemCode(input.code);
      if (!result) {
        logger.warn("Pairing redemption failed", { ip });
        throw new ORPCError("UNAUTHORIZED", {
          message: "Invalid or expired pairing code.",
        });
      }

      const apiKey = generateApiKey();
      const keyId = crypto.randomUUID();
      addApiKey(context.dataDir, {
        id: keyId,
        name: result.name,
        hash: hashCredential(apiKey),
        createdAt: Date.now(),
      });

      logger.info("Device paired", { name: result.name, keyId, ip });
      return { apiKey, name: result.name };
    }),

  listApiKeys: os.auth.listApiKeys
    .use(authMiddleware)
    .handler(({ context }) => {
      const keys = listApiKeys(context.dataDir);
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      }));
    }),

  revokeApiKey: os.auth.revokeApiKey
    .use(authMiddleware)
    .handler(({ input, context }) => {
      const revoked = revokeApiKey(context.dataDir, input.id);
      return { revoked };
    }),
};
