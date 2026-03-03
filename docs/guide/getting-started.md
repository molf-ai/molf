# Getting Started

This guide walks you through installing Molf Assistant and running your first session in under five minutes.

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0 or later)
- An API key for a supported LLM provider (e.g. `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). See [Providers](/server/providers) for the full list.

## Install

```bash
git clone https://github.com/volandevovan/molf.git
cd molf
bun install
```

## Quick Start

Molf runs as three cooperating processes: a **server** that talks to the LLM, a **worker** that executes tools in a local directory, and a **client** that provides the chat interface. Open three terminals and start them in order.

### 1. Start the Server

```bash
GEMINI_API_KEY=<your-key> bun run dev:server
```

The server binds to `ws://127.0.0.1:7600` and prints an auth token:

```
Server listening on ws://127.0.0.1:7600
Auth token: a1b2c3d4e5f6...
```

Copy this token — the worker and client both need it to connect.

::: tip Fixed token
Set `MOLF_TOKEN` to use the same token across restarts. This is useful for scripts, Docker, and multi-terminal workflows:

```bash
MOLF_TOKEN=my-secret GEMINI_API_KEY=<your-key> bun run dev:server
```
:::

To use a different model/provider:

```bash
ANTHROPIC_API_KEY=<your-key> MOLF_DEFAULT_MODEL=anthropic/claude-sonnet-4-20250514 bun run dev:server
```

### 2. Start a Worker

```bash
bun run dev:worker -- --name my-worker --token <token>
```

The worker connects to the server, registers its built-in tools (shell, file I/O, grep, glob), and waits for tool call requests.

By default the worker uses the current directory as its working directory. Use `--workdir` to point it at a specific project:

```bash
bun run dev:worker -- --name my-worker --token <token> --workdir /path/to/project
```

::: tip MCP Tools (optional)
Workers can connect to external [MCP servers](/worker/mcp) for additional tools.
Create `.mcp.json` in the workdir to enable them — no extra CLI flags needed.
:::

### 3. Launch a Client

The terminal TUI is the primary client:

```bash
MOLF_TOKEN=<token> bun run dev:client-tui
```

The TUI connects to the server, creates a session bound to the worker, and opens the chat interface.

::: info Telegram
Molf also ships a Telegram bot client. See [Telegram Bot](/clients/telegram) for setup instructions.
:::

## Your First Session

Type a message and press Enter. You'll see the response stream in real time as the LLM generates it.

Try a tool-using prompt:

```
List the files in the current directory
```

The agent will call the `glob` tool on the worker, and you'll see the tool call appear in the TUI:

```
🔧 glob({ pattern: "**/*" })
→ { files: ["src/index.ts", "package.json", ...], count: 12 }
```

The LLM reads the tool result and responds with a summary of the directory contents.

## What's Next?

- [Configuration](/guide/configuration) — server YAML, CLI flags, environment variables
- [Server Overview](/server/overview) — auth tokens, server modules
- [Providers](/server/providers) — supported LLM providers, model switching, custom providers
- [Worker Overview](/worker/overview) — identity, reconnection, working directory layout
- [Terminal TUI](/clients/terminal-tui) — slash commands, keyboard controls, session management
- [Telegram Bot](/clients/telegram) — run Molf as a Telegram bot
- [Skills](/worker/skills) — teach the agent new capabilities with Markdown skill files
- [MCP Integration](/worker/mcp) — connect external MCP servers for additional tools
- [Subagents](/server/subagents) — spawn child agents for parallel or specialized subtasks
- [Architecture](/reference/architecture) — understand the full client-server-worker model
