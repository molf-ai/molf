import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Molf Assistant',
  description: 'Self-hosted AI agent',
  themeConfig: {
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Server',
        items: [
          { text: 'Overview', link: '/server/overview' },
          { text: 'Sessions', link: '/server/sessions' },
        ],
      },
      {
        text: 'Worker',
        items: [
          { text: 'Overview', link: '/worker/overview' },
          { text: 'Skills', link: '/worker/skills' },
          { text: 'Built-in Tools', link: '/worker/tools' },
          { text: 'MCP Integration', link: '/worker/mcp' },
        ],
      },
      {
        text: 'Clients',
        items: [
          { text: 'Terminal TUI', link: '/clients/terminal-tui' },
          { text: 'Telegram Bot', link: '/clients/telegram' },
          { text: 'Custom Client', link: '/clients/custom-client' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/reference/architecture' },
          { text: 'Protocol', link: '/reference/protocol' },
          { text: 'Testing', link: '/reference/testing' },
          { text: 'Logging', link: '/reference/logging' },
          { text: 'Contributing', link: '/reference/contributing' },
          { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          { text: 'Roadmap', link: '/reference/roadmap' },
        ],
      },
    ],
  },
})
