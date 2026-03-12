---
layout: home

hero:
  name: "Molf Assistant"
  text: "Self-hosted AI agent"
  tagline: A client-server-worker architecture for running LLM agents with local tool execution.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /reference/architecture

features:
  - title: Client-Server-Worker Architecture
    details: A central tRPC WebSocket server orchestrates LLM interactions. Workers execute tools locally. Multiple clients (TUI, Telegram, custom) connect over TLS-secured WebSocket.
  - title: 16 LLM Providers
    details: Gemini, Anthropic, OpenAI, and 13 more via Vercel AI SDK with automatic API key detection. Switch models per-workspace or per-prompt. Dynamic model catalog from models.dev.
    link: /server/llm-providers
  - title: TLS with TOFU Trust
    details: TLS enabled by default with auto-generated certificates. Trust-on-first-use model for easy setup -- approve the fingerprint once, and it's pinned for future connections.
  - title: Built-in Tools & Skills
    details: Six built-in tools (shell, file read/write/edit, grep, glob), lazy-loaded skill documents, and MCP integration for connecting external tool servers.
    link: /worker/tools
  - title: Subagents
    details: Spawn isolated child agents for parallel or specialized subtasks. Two built-in agents (explore, general) plus custom agent definitions via Markdown files.
    link: /server/subagents
  - title: Tool Approval & Plugins
    details: Configurable per-tool approval rules with glob pattern matching. Extensible plugin system with 15 server hooks and 4 worker hooks.
    link: /server/tool-approval
  - title: Session Persistence
    details: Sessions stored as JSON files with automatic context summarization and pruning. Survive restarts and worker reconnections.
    link: /server/sessions
---
