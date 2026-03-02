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
    details: One central server coordinates LLM interactions. Workers execute tools locally. Multiple clients (TUI, Telegram, custom) connect to the server.
  - title: Persistent Sessions
    details: Session history stored as JSON files. Sessions persist across restarts and survive worker reconnections.
  - title: Terminal TUI & Telegram Bot
    details: Full-featured Ink/React terminal client with slash commands, plus a Telegram bot with streaming, media support, and access control.
  - title: Tool Approval
    details: Configurable per-tool, per-pattern approval rules for LLM tool calls. Sensible defaults out of the box with sensitive-file protection. Customizable via JSONC rulesets per worker.
    link: /server/tool-approval
  - title: Multi-Provider LLM Support
    details: 16+ bundled providers (Anthropic, Google, OpenAI, Mistral, Groq, and more) with automatic API key detection. Switch models per-session or per-prompt. Model catalog powered by models.dev.
    link: /server/providers
  - title: Extensible Skills & Tools
    details: Workers expose built-in tools (shell, file I/O, grep, glob), load custom skills from Markdown files, and connect to external MCP servers for additional tools. Type-safe tRPC protocol with Zod validation.
---
