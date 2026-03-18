# Getting Started

This guide walks you through installing Molf Assistant, starting all three components, and running your first session.

## Prerequisites

- **Node.js v24+** -- required by the runtime
- **pnpm** -- install via `corepack enable` (bundled with Node.js) or `npm install -g pnpm`

An LLM provider API key is **optional** at startup — you can add provider keys at any time after the server is running via the TUI `/providers` command.

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/molf-ai/molf.git
cd molf
pnpm install
```

## Starting the Server

Open a terminal and start the server:

```bash
pnpm dev:server
```

On first start, the server:

1. Generates a self-signed TLS certificate (EC prime256v1, valid 365 days)
2. Generates an auth token and prints it to the terminal
3. Listens on `wss://127.0.0.1:7600`

The terminal output includes pairing instructions for connecting workers and clients.

::: tip Fixed token
Set `MOLF_TOKEN` to use the same token across restarts:
```bash
MOLF_TOKEN=my-secret pnpm dev:server
```
:::

::: tip Adding provider keys
After the server starts, run `/providers` in the TUI to browse all 16 supported providers and add API keys at runtime — no restart needed.
:::

## Starting a Worker

Open a second terminal:

```bash
pnpm dev:worker -- --name my-worker
```

The `--name` flag is required and identifies this worker in the system.

On first connection, two setup steps happen:

1. **TLS fingerprint approval** -- the worker probes the server's certificate and displays its fingerprint. Type `y` to trust it. The certificate is pinned to `~/.molf/known_certs/` for future connections.

2. **Pairing** -- the worker initiates the pairing flow. The server terminal displays a 6-digit pairing code. Enter it in the worker terminal to receive an API key (`yk_` prefix) saved to `~/.molf/servers.json`.

On subsequent runs, the worker connects automatically using saved credentials.

You can also skip the pairing flow by passing the token directly:

```bash
pnpm dev:worker -- --name my-worker --token <token>
```

By default the worker uses the current directory as its working directory. Use `--workdir` to point it at a specific project:

```bash
pnpm dev:worker -- --name my-worker --workdir /path/to/project
```

The worker registers its built-in tools (shell_exec, read_file, write_file, edit_file, glob, grep), loads any [skills](/worker/skills) and agents from the working directory, and connects to any [MCP servers](/worker/mcp) configured in `.mcp.json`.

## Starting the TUI Client

Open a third terminal:

```bash
pnpm dev:client-tui
```

The client goes through the same TLS fingerprint and pairing flow as the worker on first run.

Once connected, you see a terminal interface (built with Ink/React) where you can type prompts and interact with the agent.

## First Session

Type a message and press Enter. The server sends your prompt to the configured LLM, which may respond with text or request tool calls.

When the LLM requests a tool call, the server dispatches it to the worker for execution. Depending on the [tool approval](/server/tool-approval) configuration, you may be prompted to approve or deny the tool call before it runs.

The agent continues running tool calls and generating responses until it completes its turn (default maximum of 10 steps per turn).

## What's Next

- [Configuration](/guide/configuration) -- all CLI flags, environment variables, and JSONC config options
- [Server Overview](/server/overview) -- how the server works, startup sequence, WebSocket settings
- [Worker Overview](/worker/overview) -- worker startup, connection, skills, and plugins
- [Terminal TUI](/clients/terminal-tui) -- slash commands, pickers, keyboard shortcuts
- [LLM Providers](/server/llm-providers) -- set up Gemini, Anthropic, OpenAI, and other providers
- [Skills](/worker/skills) -- teach the agent new capabilities with Markdown skill files
- [MCP Integration](/worker/mcp) -- connect external MCP servers for additional tools
