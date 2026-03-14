# Contributing

This page covers the development setup, tech stack, conventions, and design principles for working on Molf Assistant.

## Development Setup

### Prerequisites

- **Node.js** v24 or later
- **pnpm** (install via corepack: `corepack enable && corepack prepare`)

### Installation

```bash
pnpm install
```

### Running in Development

Start each component in a separate terminal:

```bash
# Server (binds to 127.0.0.1:7600 with TLS)
pnpm dev:server

# Worker (connects to server)
pnpm dev:worker -- --name my-worker

# Terminal client
pnpm dev:client-tui

# Telegram bot client
pnpm dev:client-telegram
```

On first run, the server prints an auth token. Workers and clients either use this token directly (`--token`) or go through the automatic pairing flow.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js v24 + tsx |
| Language | TypeScript (strict mode) |
| LLM integration | Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, etc.) |
| RPC | oRPC over WebSocket |
| Validation | Zod 4 |
| Terminal UI | Ink 5 + React 18 |
| Telegram bot | grammY |
| Test runner | Vitest |
| Logging | LogTape |
| Package manager | pnpm 10.x with workspaces |

## Package Conventions

All packages live under `packages/`. The dependency flow is:

```
protocol  ->  agent-core  ->  server
protocol  ->  worker
protocol  ->  client-tui
protocol  ->  client-telegram
protocol  ->  plugin-cron
protocol  ->  plugin-mcp
```

- `protocol` contains shared types, Zod schemas, and the plugin system. It has no runtime dependencies on other packages.
- `agent-core` builds on `protocol` to provide the Agent class and provider registry.
- `server` depends on both `protocol` and `agent-core`.
- Everything else depends only on `protocol`.

### Import Rules

- Never import from `server` in `worker` or vice versa.
- Tool execution happens on the **worker**. LLM orchestration happens on the **server**. Keep this boundary clear.
- Use the `protocol` package for types shared across packages.

## Testing Requirements

All new code must have test coverage. See [Testing](./testing.md) for the full guide.

```bash
pnpm test          # unit + integration
pnpm test:unit     # unit only
pnpm test:e2e      # integration
pnpm test:coverage # coverage report
```

### Key Testing Conventions

- Use `vi.mock` for mocking (hoisted automatically by Vitest).
- Use `vi.spyOn` for observing calls to real implementations.
- Never add test-only code paths or mocks to production code.
- Use helpers from `packages/test-utils/` for temp directories, env guards, port allocation, and LLM mocks.
- Integration tests use helpers from `packages/e2e/helpers/` to spin up real server/worker instances.

## Design Principles

### No test-only mocks in production code

Use `vi.mock` and `vi.spyOn` in test files. Production modules should not contain `if (process.env.NODE_ENV === "test")` branches or injectable mock slots.

### One implementation = no interface

Extract an interface only when there are multiple concrete implementations. A single class does not need a matching interface.

### Don't propagate options you don't use

Every parameter is a commitment. If a function accepts an option only to pass it through, reconsider the API design.

### Solve the actual problem, not a general case

Don't add abstractions for imagined future needs. Build what is needed now; refactor when the second use case arrives.

### No leaky abstractions

Each layer owns its domain. Don't expose implementation details across package boundaries. The server should not know about worker file paths; the worker should not know about LLM prompt construction.

## Adding Code

### Adding a Tool

1. Define the tool's Zod input schema in `packages/protocol/src/tool-definitions/`.
2. Implement the handler in the worker package.
3. Register the tool in the worker's tool loading code.
4. Write unit tests in `packages/worker/tests/`.

### Adding an oRPC Procedure

1. Add input/output Zod schemas in `packages/protocol/src/schemas.ts`.
2. Add the procedure to the appropriate router in `packages/server/src/routers/`.
3. Wire any new dependencies through the server context.
4. Write unit tests and, if needed, an integration test in `packages/e2e/`.

### Adding a Plugin Hook

1. Add the hook event type to `ServerHookEvents` or `WorkerHookEvents` in `packages/protocol/src/plugin.ts`.
2. Set the hook mode in `HOOK_MODES` (modifying or observing).
3. If blockable, add to `BLOCKABLE_HOOKS`.
4. Dispatch the hook at the appropriate point in the server or worker code.
5. Write tests covering both the dispatch and a plugin handler responding to it.

### Adding a Plugin

See [Plugins](./plugins.md) for the `definePlugin` API and plugin structure.

## Type-Checking

```bash
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
```

Each package has its own `tsconfig.json`. TypeScript is configured in strict mode across all packages.

## See also

- [Architecture](./architecture.md) -- package graph and key abstractions
- [Testing](./testing.md) -- test runner, utilities, and patterns
- [Plugins](./plugins.md) -- writing server and worker plugins
