# Providers

## Overview

Molf uses a catalog-based multi-provider architecture that supports 16+ AI SDK providers out of the box. Instead of hardcoding individual providers, the server initializes a provider registry at startup that auto-detects available providers by scanning for API key environment variables.

Models are identified using a combined `"provider/model"` format (e.g. `"anthropic/claude-sonnet-4-20250514"`). This format is used everywhere — in config files, environment variables, tRPC procedures, and session overrides.

The provider system lives in `agent-core/src/providers/`.

## Bundled Providers

The following providers are bundled and available without any additional installation:

| Provider ID | Name | NPM Package | API Key Env Var |
|-------------|------|-------------|-----------------|
| `anthropic` | Anthropic | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` |
| `openai` | OpenAI | `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `openai-compatible` | OpenAI Compatible | `@ai-sdk/openai-compatible` | *(varies)* |
| `xai` | xAI | `@ai-sdk/xai` | `XAI_API_KEY` |
| `mistral` | Mistral | `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `groq` | Groq | `@ai-sdk/groq` | `GROQ_API_KEY` |
| `deepinfra` | DeepInfra | `@ai-sdk/deepinfra` | `DEEPINFRA_API_KEY` |
| `cerebras` | Cerebras | `@ai-sdk/cerebras` | `CEREBRAS_API_KEY` |
| `cohere` | Cohere | `@ai-sdk/cohere` | `COHERE_API_KEY` |
| `togetherai` | Together AI | `@ai-sdk/togetherai` | `TOGETHER_AI_API_KEY` |
| `perplexity` | Perplexity | `@ai-sdk/perplexity` | `PERPLEXITY_API_KEY` |
| `amazon-bedrock` | Amazon Bedrock | `@ai-sdk/amazon-bedrock` | `AWS_ACCESS_KEY_ID` |
| `google-vertex` | Google Vertex AI | `@ai-sdk/google-vertex` | *(service account)* |
| `azure` | Azure OpenAI | `@ai-sdk/azure` | `AZURE_API_KEY` |
| `openrouter` | OpenRouter | `@openrouter/ai-sdk-provider` | `OPENROUTER_API_KEY` |

Any provider with a detected API key is automatically available for model selection.

## Configuration

### Default Model

Set the default model in `molf.yaml` using the `"provider/model"` format:

```yaml
model: "anthropic/claude-sonnet-4-20250514"
```

Or override via the `MOLF_DEFAULT_MODEL` environment variable:

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

API keys are auto-detected from environment variables. The server scans for the expected env var names listed in the [Bundled Providers](#bundled-providers) table at startup.

### Custom Providers

Add user-defined providers via the `providers` block in `molf.yaml`. This is useful for self-hosted or OpenAI-compatible endpoints:

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
| `npm` | Yes | AI SDK package name (e.g. `"@ai-sdk/openai-compatible"`) |
| `env` | Yes | List of environment variable names for API key detection |
| `models` | No | Map of model IDs to model metadata (name, limits) |

## Model Switching

### Per-Session Override

Override the model for an individual session without affecting other sessions:

- **TUI**: `/model` command opens an interactive model picker
- **Telegram**: `/model` command shows an inline keyboard
- **API**: `session.setModel` mutation

```typescript
// Set a model for this session
await trpc.session.setModel.mutate({
  sessionId: session.sessionId,
  model: "openai/gpt-4o",
});

// Clear the override (revert to server default)
await trpc.session.setModel.mutate({
  sessionId: session.sessionId,
  model: null,
});
```

### Per-Prompt Override

Pass `model` on individual prompts for one-off model selection without changing the session default:

```typescript
await trpc.agent.prompt.mutate({
  sessionId: session.sessionId,
  text: "Analyze this code",
  model: "anthropic/claude-sonnet-4-20250514",
});
```

### Resolution Priority

When resolving which model to use, the server checks in order:

1. **Per-prompt** `model` parameter (if provided)
2. **Per-session** model override (set via `session.setModel` or `config.model` at creation)
3. **Server default** model (from `molf.yaml` or `MOLF_DEFAULT_MODEL`)

## models.dev Catalog

The server fetches provider and model metadata from [models.dev](https://models.dev) to populate model capabilities, costs, limits, and status information.

- **Source**: `https://models.dev/api.json`
- **Fetch timeout**: 5 seconds
- **Refresh interval**: 60 minutes
- **Disk cache**: `{cacheDir}/models.json` — loaded first on startup, then refreshed in the background
- **Disable**: Set `MODELS_DEV_DISABLE=1` to skip fetching entirely (uses disk cache only)

The catalog provides model metadata including context window sizes (used for automatic summarization triggers), cost information, and capability flags (reasoning, tool calling, input/output modalities).

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
| `MODELS_DEV_DISABLE` | Set to `1` to disable fetching model catalog from models.dev |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini API key (also accepts `GEMINI_API_KEY`) |
| `OPENAI_API_KEY` | OpenAI API key |
| `XAI_API_KEY` | xAI API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `GROQ_API_KEY` | Groq API key |
| `DEEPINFRA_API_KEY` | DeepInfra API key |
| `CEREBRAS_API_KEY` | Cerebras API key |
| `COHERE_API_KEY` | Cohere API key |
| `TOGETHER_AI_API_KEY` | Together AI API key |
| `PERPLEXITY_API_KEY` | Perplexity API key |
| `AWS_ACCESS_KEY_ID` | Amazon Bedrock (AWS credentials) |
| `AZURE_API_KEY` | Azure OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |

## See Also

- [Configuration](/guide/configuration) — server YAML config, CLI flags, environment variables
- [Sessions](/server/sessions) — per-session model overrides, session lifecycle
- [Protocol Reference](/reference/protocol) — provider router, session.setModel, model types
