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
    details: Conversation history stored as JSON files. Sessions persist across restarts and survive worker reconnections.
  - title: Terminal TUI & Telegram Bot
    details: Full-featured Ink/React terminal client with slash commands, plus a Telegram bot with streaming, media support, and access control.
  - title: Extensible Skills & Tools
    details: Workers expose built-in tools (shell, file I/O, grep, glob) and load custom skills from Markdown files. Type-safe tRPC protocol with Zod validation.
---
