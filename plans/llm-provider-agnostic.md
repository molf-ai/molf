# Provider-Agnostic LLM Integration Plan

## Goal
Make LLM integration provider-agnostic, keep Vercel AI SDK support (Gemini + Anthropic), and allow pluggable non‑Vercel providers without hardcoded dependencies.

## Plan
1. **Define a provider abstraction in `@molf-ai/agent-core`.**
   - Add an `LLMProvider` interface that can produce a streaming response compatible with the existing agent loop.
   - Introduce a `ProviderRegistry` (or similar) that resolves providers by name and can be extended at runtime.
   - Update `LLMConfig` to be provider‑agnostic (e.g., `provider: "gemini" | "anthropic" | string`, optional `transport`/`kind`, and provider‑specific options like `apiKey`).

2. **Refactor `Agent` to use the provider abstraction.**
   - Replace the hardcoded `createGoogleGenerativeAI` path with `ProviderRegistry.get(config.llm.provider)`.
   - Move API‑key resolution into provider implementations (Gemini → `GEMINI_API_KEY`, Anthropic → `ANTHROPIC_API_KEY`).
   - Keep the current streaming event handling unchanged by ensuring provider adapters emit the same stream event shape.

3. **Implement Vercel AI provider adapters.**
   - Add `@ai-sdk/anthropic` dependency in `packages/agent-core/package.json`.
   - Implement adapters for Gemini and Anthropic that call `streamText` from `ai` with the provider’s model factory.
   - Add a clear error message when the required API key is missing.

4. **Enable non‑Vercel providers.**
   - Expose a public hook for registering custom providers (e.g., `registerProvider("my-provider", impl)`), or allow injection via `new Agent(..., { providerRegistry })`.
   - Document the minimal adapter contract (input params, required stream events, and how to map tools/messages).

5. **Update tests and mocks.**
   - Update agent-core tests and server tests to mock the provider registry rather than `@ai-sdk/google` directly.
   - Extend test-utils mocks to include a generic provider adapter and update any gemini‑specific expectations.
   - Add tests for provider selection and missing API key behavior for Anthropic.

6. **Update docs and examples.**
   - Update `README.md` and `docs/server-architecture.md` to reflect provider‑agnostic LLMs and list supported Vercel providers (Gemini + Anthropic).
   - Add example config snippets showing how to set `llm.provider: "anthropic"` and `ANTHROPIC_API_KEY`.
   - Update agent-core examples to show provider selection if relevant.

## Deliverables
- Provider abstraction + registry in `@molf-ai/agent-core`.
- Vercel AI adapters for Gemini and Anthropic with environment key support.
- Extension point for non‑Vercel providers.
- Updated tests, docs, and examples.
