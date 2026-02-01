/**
 * Convert markdown to Telegram-compatible HTML.
 *
 * Supported conversions:
 *   **bold**     -> <b>bold</b>
 *   *italic*     -> <i>italic</i>
 *   ~~strike~~   -> <s>strike</s>
 *   `code`       -> <code>code</code>
 *   ```lang\n…\n``` -> <pre><code class="language-lang">…</code></pre>
 *   [text](url)  -> <a href="url">text</a>
 *
 * On parse error from Telegram API, callers should retry with stripHtml().
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * Convert markdown text to Telegram HTML.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for code fence
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        // Opening fence
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockContent = [];
      } else {
        // Closing fence
        inCodeBlock = false;
        const escaped = escapeHtml(codeBlockContent.join("\n"));
        if (codeBlockLang) {
          result.push(
            `<pre><code class="language-${escapeHtml(codeBlockLang)}">${escaped}</code></pre>`,
          );
        } else {
          result.push(`<pre><code>${escaped}</code></pre>`);
        }
        codeBlockLang = "";
        codeBlockContent = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    result.push(convertInlineMarkdown(line));
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    const escaped = escapeHtml(codeBlockContent.join("\n"));
    if (codeBlockLang) {
      result.push(
        `<pre><code class="language-${escapeHtml(codeBlockLang)}">${escaped}</code></pre>`,
      );
    } else {
      result.push(`<pre><code>${escaped}</code></pre>`);
    }
  }

  return result.join("\n");
}

/**
 * Convert inline markdown formatting within a single line.
 */
function convertInlineMarkdown(line: string): string {
  // Process the line character by character to handle nesting correctly
  let result = "";
  let i = 0;

  while (i < line.length) {
    // Inline code (backtick) — highest priority, no nesting inside
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        result += `<code>${escapeHtml(line.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Links: [text](url)
    if (line[i] === "[") {
      const match = line.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (match) {
        const text = escapeHtml(match[1]);
        const url = match[2].replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        result += `<a href="${url}">${text}</a>`;
        i += match[0].length;
        continue;
      }
    }

    // Bold: **text**
    if (line[i] === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2);
      if (end !== -1) {
        result += `<b>${convertInlineMarkdown(line.slice(i + 2, end))}</b>`;
        i = end + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (line[i] === "~" && line[i + 1] === "~") {
      const end = line.indexOf("~~", i + 2);
      if (end !== -1) {
        result += `<s>${convertInlineMarkdown(line.slice(i + 2, end))}</s>`;
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* (single asterisk, not followed by another)
    if (line[i] === "*" && line[i + 1] !== "*") {
      const end = findSingleAsteriskEnd(line, i + 1);
      if (end !== -1) {
        result += `<i>${convertInlineMarkdown(line.slice(i + 1, end))}</i>`;
        i = end + 1;
        continue;
      }
    }

    // Regular character — escape HTML
    const ch = line[i];
    if (ch === "&") result += "&amp;";
    else if (ch === "<") result += "&lt;";
    else if (ch === ">") result += "&gt;";
    else result += ch;

    i++;
  }

  return result;
}

/**
 * Find the closing single asterisk for italic, avoiding double asterisks.
 */
function findSingleAsteriskEnd(line: string, start: number): number {
  for (let i = start; i < line.length; i++) {
    if (line[i] === "*" && line[i + 1] !== "*" && (i === start || line[i - 1] !== "*")) {
      return i;
    }
  }
  return -1;
}
