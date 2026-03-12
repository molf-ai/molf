# syntax=docker/dockerfile:1

# ── base: node + pnpm + native build tools ──────────────────────────
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN apk add --no-cache python3 make g++

# ── build: install deps + deploy targets ────────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm deploy --filter=@molf-ai/server --prod /prod/server
RUN pnpm deploy --filter=@molf-ai/worker --prod /prod/worker
RUN pnpm deploy --filter=@molf-ai/client-telegram --prod /prod/telegram

# ── runtime base: minimal node + tsx ─────────────────────────────────
FROM node:24-alpine AS runtime
RUN npm install -g tsx && \
    addgroup -S molf && adduser -S molf -G molf

# ── server ───────────────────────────────────────────────────────────
FROM runtime AS server
WORKDIR /app
COPY --from=build /prod/server .
RUN mkdir -p /data && chown molf:molf /data
USER molf
EXPOSE 7600
ENTRYPOINT ["tsx", "src/main.ts", "--"]
CMD ["--host", "0.0.0.0", "--data-dir", "/data"]

# ── worker ───────────────────────────────────────────────────────────
FROM runtime AS worker
WORKDIR /app
COPY --from=build /prod/worker .
RUN mkdir -p /work && chown molf:molf /work
USER molf
ENTRYPOINT ["tsx", "src/index.ts", "--"]
CMD ["--name", "default"]

# ── telegram ─────────────────────────────────────────────────────────
FROM runtime AS telegram
WORKDIR /app
COPY --from=build /prod/telegram .
USER molf
ENTRYPOINT ["tsx", "src/index.ts"]
