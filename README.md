# Molf

**AI coding agent with a client-server-worker architecture.**

> [!WARNING]
> Molf is under active development. Expect breaking changes, incomplete features, and rough edges. **Not ready for production use.**

## What Makes Molf Different

Most AI coding agents run as a single monolithic process. Molf takes a different approach with a **client-server-worker architecture**:

- **Server** orchestrates LLM interactions and manages sessions
- **Workers** execute tools locally in your project directory
- **Clients** (terminal UI, Telegram, or build your own) connect to the server

This separation unlocks possibilities that monolithic agents can't offer — multiple clients sharing the same session, workers running on different machines, centralized session history, and independent scaling of each component.

### Built-in TLS with TOFU

Molf auto-generates TLS certificates on first start and uses a **Trust-on-First-Use** model for secure connections out of the box. No manual cert setup, no plain HTTP — just approve the fingerprint once and you're connected. This makes running the server and workers across different hosts straightforward and secure by default.

### Extensible Without Being Opinionated

The goal is to be a **solid, flexible foundation** rather than an opinionated framework. Molf provides:

- A **plugin system** with 19 hooks (server and worker side) for deep customization
- **Selective opt-in** — enable only the functionality you need
- **Many LLM providers** via Vercel AI SDK (Gemini, Anthropic, OpenAI, Mistral, and more) plus custom OpenAI-compatible endpoints
- A **skill system** for adding domain-specific knowledge to agents
- **MCP support** for integrating external tool servers

## Local Development Setup

**Prerequisites:** Node.js v24+, pnpm

**1. Clone and install:**

```bash
git clone https://github.com/nicקקe/molf.git
cd molf
pnpm install
```

**2. Configure `.env`:**

Copy `.env.example` to `.env` and set at minimum:

```env
MOLF_DEFAULT_MODEL=google/gemini-2.5-flash
GEMINI_API_KEY=<your-key>
```

You can use any supported provider — see [LLM providers docs](docs/server/llm-providers.md) for the full list of env vars and model ID format.

**3. Start the server and workers:**

```bash
pnpm dev
```

This launches the server and two test workers in a single process.

**4. Start a client:**

In a separate terminal, run one of:

```bash
pnpm dev:client-tui        # Terminal UI
pnpm dev:client-telegram    # Telegram bot
```

On first run, the server generates a TLS certificate and auth token. The client will prompt you to approve the certificate fingerprint and enter a pairing code displayed in the server output.

## Production Deployment

Just ask your friendly agent 🤖

## Architecture

```
┌─────────────┐   ┌─────────────────┐   ┌──────────────┐
│  Client TUI │   │ Client Telegram │   │ Custom Client│
└──────┬──────┘   └───────┬─────────┘   └──────┬───────┘
       │      WebSocket/tRPC (TLS)              │
       └──────────────┬────────────────────────-┘
                      │
              ┌───────┴────────┐
              │     Server     │
              │  (LLM, Sessions│
              │   EventBus)    │
              └───────┬────────┘
                      │
           WebSocket/tRPC (TLS)
                      │
              ┌───────┴────────┐
              │     Worker     │
              │  (Tool exec,   │
              │   Skills, MCP) │
              └────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `protocol` | Shared types, Zod schemas, tRPC router, TLS/credentials |
| `agent-core` | Agent class, session management, LLM provider registry |
| `server` | WebSocket server, session manager, tool dispatch, event bus |
| `worker` | Tool executor, skill loading, MCP client |
| `client-tui` | Terminal UI (Ink + React) |
| `client-telegram` | Telegram bot (grammY) |
| `plugin-cron` | Scheduled task execution |
| `plugin-mcp` | MCP server integration |

## Planned Features

No particular order — just things we want to build next:

- **Cross-worker task delegation** — a tool that lets one worker delegate tasks to another. For example, a worker in your project directory can hand off a video processing job to a worker running in a Docker container with ffmpeg and other media tools pre-installed.
- **CLI installer** — a setup utility that simplifies installing and configuring the full server-worker-client stack.
- **Worker presets** — pre-configured worker templates with curated, well-isolated toolsets. Pick the ones you need when deploying your agent setup.
- **Web client** — a browser-based UI / admin panel as an alternative to the terminal client.
- **Agent interop layer** — plugin-based integration with OpenClaw and other agent frameworks.

## Tech Stack

Node.js, TypeScript (strict), tRPC v11, Zod 4, Vercel AI SDK, Ink 5 + React 18, Vitest

## Acknowledgements

Molf wouldn't exist in its current form without the inspiration drawn from these projects:

- [OpenCode](https://github.com/anomalyco/opencode) — open source AI coding agent built for the terminal
- [OpenClaw](https://github.com/openclaw/openclaw) — personal AI assistant with multi-channel access and a rich plugin ecosystem
- [Moltis](https://github.com/moltis-org/moltis) — Rust-native AI gateway with sandboxed execution and multi-provider support
- [PicoClaw](https://github.com/sipeed/picoclaw) — ultra-lightweight AI agent that runs on minimal hardware

Thank you to the maintainers and contributors of these projects for pushing the space forward.

## License

MIT
