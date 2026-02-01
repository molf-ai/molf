import { describe, it, expect } from "bun:test";
import { markdownToTelegramHtml, escapeHtml, stripHtml } from "../src/format.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    );
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles multiple special chars", () => {
    expect(escapeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    expect(stripHtml("<b>bold</b> and <i>italic</i>")).toBe("bold and italic");
  });

  it("handles nested tags", () => {
    expect(stripHtml("<b><i>nested</i></b>")).toBe("nested");
  });

  it("returns plain text unchanged", () => {
    expect(stripHtml("no tags here")).toBe("no tags here");
  });

  it("strips self-closing tags", () => {
    expect(stripHtml("text<br/>more")).toBe("textmore");
  });

  it("strips tags with attributes", () => {
    expect(stripHtml('<a href="url">link</a>')).toBe("link");
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts bold", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("converts italic", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~strike~~")).toBe("<s>strike</s>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("`<script>`")).toBe(
      "<code>&lt;script&gt;</code>",
    );
  });

  it("converts links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it("converts fenced code blocks without language", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToTelegramHtml(input)).toBe(
      "<pre><code>const x = 1;</code></pre>",
    );
  });

  it("converts fenced code blocks with language", () => {
    const input = "```typescript\nconst x: number = 1;\n```";
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre><code class="language-typescript">const x: number = 1;</code></pre>',
    );
  });

  it("escapes HTML inside code blocks", () => {
    const input = "```\n<div>test</div>\n```";
    expect(markdownToTelegramHtml(input)).toBe(
      "<pre><code>&lt;div&gt;test&lt;/div&gt;</code></pre>",
    );
  });

  it("handles mixed inline formatting", () => {
    const input = "**bold** and *italic* and `code`";
    expect(markdownToTelegramHtml(input)).toBe(
      "<b>bold</b> and <i>italic</i> and <code>code</code>",
    );
  });

  it("escapes regular HTML entities", () => {
    expect(markdownToTelegramHtml("a & b < c > d")).toBe(
      "a &amp; b &lt; c &gt; d",
    );
  });

  it("handles multiline text with paragraphs", () => {
    const input = "Line 1\n\nLine 2";
    expect(markdownToTelegramHtml(input)).toBe("Line 1\n\nLine 2");
  });

  it("handles unclosed code block", () => {
    const input = "```\nconst x = 1;";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("const x = 1;");
  });

  it("handles empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("handles plain text without formatting", () => {
    expect(markdownToTelegramHtml("Hello world")).toBe("Hello world");
  });

  it("handles bold with nested italic", () => {
    const input = "**bold *italic* text**";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<b>");
    expect(result).toContain("</b>");
  });

  it("handles links with special characters in URL", () => {
    const input = "[test](https://example.com/path?a=1&b=2)";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("href=");
    expect(result).toContain("&amp;");
  });

  it("handles unclosed bold marker", () => {
    const input = "**unclosed bold";
    const result = markdownToTelegramHtml(input);
    // Should not crash — treat markers as literal text
    expect(result).toContain("**");
  });

  it("handles unclosed italic marker", () => {
    const input = "*unclosed italic";
    const result = markdownToTelegramHtml(input);
    // Should not crash — treat marker as literal
    expect(result).toContain("*");
  });

  it("handles unclosed strikethrough marker", () => {
    const input = "~~unclosed strike";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("~~");
  });

  it("handles unclosed inline code marker", () => {
    const input = "`unclosed code";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("`");
  });

  it("handles link text without URL", () => {
    const input = "[text only]";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("[text only]");
  });

  it("handles multi-line code block with multiple lines", () => {
    const input = "```js\nline1\nline2\nline3\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("line1\nline2\nline3");
  });

  it("handles adjacent bold and italic", () => {
    const input = "**bold***italic*";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<b>");
    expect(result).toContain("<i>");
  });

  it("handles code blocks with empty language tag", () => {
    const input = "```\ncode\n```";
    expect(markdownToTelegramHtml(input)).toBe("<pre><code>code</code></pre>");
  });

  it("handles unclosed code block with language", () => {
    const input = "```python\nprint('hello')";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('class="language-python"');
    expect(result).toContain("print(");
  });
});
