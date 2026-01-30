const DEFAULT_SYSTEM_PROMPT =
  "You are Molf, a helpful and knowledgeable AI assistant. " +
  "You provide clear, accurate, and concise responses. " +
  "When you don't know something, you say so honestly.";

export function getDefaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}

export function buildSystemPrompt(
  ...parts: Array<string | undefined | null>
): string {
  return parts.filter(Boolean).join("\n\n");
}
