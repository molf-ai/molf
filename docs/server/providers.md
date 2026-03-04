# Providers & Models

## Overview

Molf uses the [AI SDK](https://ai-sdk.dev/) and [models.dev](https://models.dev) to support **75+ LLM providers** and hundreds of models out of the box. The provider and model catalog implementation is borrowed from [opencode](https://opencode.ai/).

Instead of maintaining a hardcoded list of models, Molf fetches the full provider and model catalog from models.dev at startup. This catalog contains metadata for every model — context window sizes, costs, capabilities (reasoning, tool calling, input/output modalities), and status. Providers are auto-detected by scanning for API key environment variables.

Models are identified using a `"provider/model"` format (e.g. `"anthropic/claude-sonnet-4-20250514"`). This format is used everywhere — in config files, environment variables, tRPC procedures, and session overrides. The full list of built-in provider and model names can be found on [models.dev](https://models.dev).

The provider system lives in `agent-core/src/providers/`.

## How It Works

At startup, the server runs a 7-step initialization pipeline:

1. **Load catalog** — Fetch provider/model metadata from models.dev (with fallback chain)
2. **Transform catalog** — Convert raw catalog entries into internal `ProviderInfo` structures
3. **Determine allowed providers** — Build the set from the default model's provider, `enabled_providers` list, or `enable_all_providers` flag
4. **Detect API keys** — Scan environment variables for each allowed provider
5. **Merge config** — Apply YAML overrides and custom provider definitions
6. **Apply custom loaders** — Set up provider-specific SDK routing (e.g. Anthropic beta headers, OpenAI API selection)
7. **Filter** — Remove providers without API keys, deprecated models, and empty providers

Any provider listed on models.dev that has its API key set in the environment is automatically available for model selection — no additional configuration needed.

## models.dev Catalog

The models.dev catalog is the source of truth for provider and model metadata. It provides:

- **Model capabilities** — reasoning, tool calling, temperature support, input/output modalities
- **Token limits** — context window and max output sizes (used for automatic summarization triggers)
- **Cost information** — input/output token pricing, cache read/write costs
- **Model status** — active, alpha, beta, deprecated (deprecated models are filtered out)

### Fetching & Caching

The catalog uses a multi-tier fallback chain for reliability:

1. **In-memory cache** — Used if less than 60 minutes old
2. **Disk cache** — `{cacheDir}/models.json`, loaded on startup
3. **Bundled snapshot** — Embedded at build time for compiled binaries (always available offline)
4. **Live fetch** — `https://models.dev/api.json` with a 5-second timeout
5. **Empty fallback** — Graceful degradation if all sources fail

After startup, the catalog refreshes in the background every 60 minutes.

| Variable | Description |
|----------|-------------|
| `MODELS_DEV_DISABLE` | Set to `1` to skip live fetching (uses disk cache / bundled snapshot only) |

## Bundled SDK Providers

Molf ships with 16 AI SDK packages compiled in. These are the SDK adapters that translate between the Vercel AI SDK and each provider's API:

| Provider ID | NPM Package | API Key Env Var |
|-------------|-------------|-----------------|
| `anthropic` | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `openai-compatible` | `@ai-sdk/openai-compatible` | *(varies)* |
| `xai` | `@ai-sdk/xai` | `XAI_API_KEY` |
| `mistral` | `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `groq` | `@ai-sdk/groq` | `GROQ_API_KEY` |
| `deepinfra` | `@ai-sdk/deepinfra` | `DEEPINFRA_API_KEY` |
| `cerebras` | `@ai-sdk/cerebras` | `CEREBRAS_API_KEY` |
| `cohere` | `@ai-sdk/cohere` | `COHERE_API_KEY` |
| `togetherai` | `@ai-sdk/togetherai` | `TOGETHER_AI_API_KEY` |
| `perplexity` | `@ai-sdk/perplexity` | `PERPLEXITY_API_KEY` |
| `amazon-bedrock` | `@ai-sdk/amazon-bedrock` | `AWS_ACCESS_KEY_ID` |
| `google-vertex` | `@ai-sdk/google-vertex` | *(service account)* |
| `azure` | `@ai-sdk/azure` | `AZURE_API_KEY` |
| `openrouter` | `@openrouter/ai-sdk-provider` | `OPENROUTER_API_KEY` |

The models.dev catalog covers far more providers than these 16. However, the SDK packages above are what's compiled into the binary. To use a provider that isn't listed here, configure it as a [custom provider](#custom-providers) using the `openai-compatible` adapter, or use a routing provider like OpenRouter.

## Configuration

### Default Model

Set the default model in `molf.yaml` using the `"provider/model"` format:

```yaml
model: "anthropic/claude-sonnet-4-20250514"
```

Or override via environment variable:

```bash
MOLF_DEFAULT_MODEL="google/gemini-3-flash-preview" bun run dev:server
```

### Enabling Providers

By default, only the default model's provider is enabled. To make additional providers available for model switching:

**Option 1** — list specific providers with `enabled_providers`:

```yaml
model: "anthropic/claude-sonnet-4-20250514"
enabled_providers:
  - google
  - openai
```

**Option 2** — enable all providers that have detected API keys:

```yaml
model: "anthropic/claude-sonnet-4-20250514"
enable_all_providers: true
```

Or via environment variable:

```bash
MOLF_ENABLE_ALL_PROVIDERS=1 bun run dev:server
```

### Custom Providers

Add user-defined providers via the `providers` block in `molf.yaml`. This is useful for self-hosted or OpenAI-compatible endpoints that aren't in the models.dev catalog:

```yaml
model: "my-local-llm/llama-3"
providers:
  my-local-llm:
    npm: "@ai-sdk/openai-compatible"
    env: ["MY_LOCAL_KEY"]
    models:
      llama-3:
        name: "Llama 3"
        limit:
          context: 128000
          output: 8192
```

Custom provider fields:

| Field | Required | Description |
|-------|----------|-------------|
| `npm` | Yes | AI SDK package name (must be one of the [bundled SDK packages](#bundled-sdk-providers)) |
| `env` | Yes | List of environment variable names for API key detection |
| `models` | No | Map of model IDs to model metadata (name, limits). Standard providers pull these from models.dev automatically. |

Custom providers are implicitly enabled — they don't need to appear in `enabled_providers`.

## Model Switching

### Per-Workspace Override

Override the model for all sessions within a workspace:

- **TUI**: `/model` command opens an interactive model picker
- **Telegram**: `/model` command shows an inline keyboard
- **API**: `workspace.setConfig` mutation

```typescript
// Set a model for this workspace
await trpc.workspace.setConfig.mutate({
  workerId: "worker-id",
  workspaceId: "workspace-id",
  config: { model: "openai/gpt-4o" },
});

// Clear the override (revert to server default)
await trpc.workspace.setConfig.mutate({
  workerId: "worker-id",
  workspaceId: "workspace-id",
  config: { model: undefined },
});
```

### Per-Prompt Override

Pass `modelId` on individual prompts for one-off model selection without changing the workspace default:

```typescript
await trpc.agent.prompt.mutate({
  sessionId: session.sessionId,
  text: "Analyze this code",
  modelId: "anthropic/claude-sonnet-4-20250514",
});
```

### Resolution Priority

When resolving which model to use, the server checks in order:

1. **Per-prompt** `modelId` parameter (if provided)
2. **Workspace config** model (set via `workspace.setConfig`)
3. **Server default** model (from `molf.yaml` or `MOLF_DEFAULT_MODEL`)

## Provider-Specific Behavior

The provider system applies automatic transforms and options based on the provider:

- **Anthropic**: Adds `interleaved-thinking-2025-05-14` beta header for extended thinking. Applies ephemeral cache control. Filters empty text parts from messages. Temperature is left unset (uses provider default).
- **Google**: Injects `thinkingConfig` in provider options. Temperature defaults to 1.0.
- **OpenAI**: GPT-5+ models use the Responses API (`openai.responses()`), older models use the Chat API (`openai.chat()`). Sets `store: false` option.
- **All providers**: Tool call IDs are normalized to match the `^[a-zA-Z0-9_-]+$` pattern. Provider metadata from other providers is stripped from messages. Max output tokens are capped at `min(model.limit.output, 32000)`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MOLF_DEFAULT_MODEL` | Override default model (e.g. `"anthropic/claude-sonnet-4-20250514"`) |
| `MOLF_ENABLE_ALL_PROVIDERS` | Set to `1` to enable all providers with detected API keys |
| `MODELS_DEV_DISABLE` | Set to `1` to disable live fetching of model catalog from models.dev |

Provider API keys are auto-detected from environment variables. See the [Bundled SDK Providers](#bundled-sdk-providers) table for the expected variable names.

## See Also

- [models.dev](https://models.dev) — full list of supported providers and models
- [Configuration](/guide/configuration) — server YAML config, CLI flags, environment variables
- [Sessions](/server/sessions) — session lifecycle, workspace-level model resolution
- [Protocol Reference](/reference/protocol) — provider router, workspace.setConfig, model types
