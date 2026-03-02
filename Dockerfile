# ---- Builder: install deps + compile musl binaries ----
FROM oven/bun:alpine AS builder
WORKDIR /app

# Layer-cached dependency install
COPY package.json bun.lock bunfig.toml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/client-tui/package.json packages/client-tui/package.json
COPY packages/client-telegram/package.json packages/client-telegram/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN bun install --frozen-lockfile

# Copy source and build musl binaries for current arch
COPY . .
ARG TARGETARCH
RUN bun run scripts/build.ts \
      --platform=linux-$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "arm64")-musl

# Collect binaries into a flat directory
RUN mkdir -p /out && cp dist/linux-*-musl/molf-* /out/

# ---- Minimal runtime base ----
FROM alpine AS base
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add --no-cache libgcc libstdc++

# ---- Component images (select with: docker build --target <name>) ----
FROM base AS server
COPY --from=builder /out/molf-server /usr/local/bin/molf-server
EXPOSE 7600
ENTRYPOINT ["molf-server"]
CMD ["--host", "0.0.0.0"]

FROM base AS worker
COPY --from=builder /out/molf-worker /usr/local/bin/molf-worker
ENTRYPOINT ["molf-worker"]

FROM base AS tui
COPY --from=builder /out/molf-tui /usr/local/bin/molf-tui
ENTRYPOINT ["molf-tui"]

FROM base AS telegram
COPY --from=builder /out/molf-telegram /usr/local/bin/molf-telegram
ENTRYPOINT ["molf-telegram"]
