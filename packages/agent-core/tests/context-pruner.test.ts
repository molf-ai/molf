import { describe, test, expect } from "bun:test";
import {
  pruneContext,
  isContextLengthError,
  estimateMessageChars,
  estimateContextChars,
  findAssistantCutoffIndex,
  findFirstUserIndex,
  softTrimContent,
  CHARS_PER_TOKEN_ESTIMATE,
  IMAGE_CHAR_ESTIMATE,
  NON_IMAGE_CHAR_ESTIMATE,
  KEEP_LAST_ASSISTANTS,
  SOFT_TRIM_RATIO,
  HARD_CLEAR_RATIO,
  SOFT_TRIM_MAX_CHARS,
  SOFT_TRIM_HEAD_CHARS,
  SOFT_TRIM_TAIL_CHARS,
  HARD_CLEAR_PLACEHOLDER,
  MIN_PRUNABLE_TOOL_CHARS,
} from "../src/context-pruner.js";
import type { SessionMessage, ToolCall } from "../src/types.js";

// --- Helpers ---

let nextId = 0;
function msg(
  role: SessionMessage["role"],
  content: string,
  extra?: Partial<SessionMessage>,
): SessionMessage {
  return {
    id: `msg-${nextId++}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function userMsg(content = "hello") {
  return msg("user", content);
}

function assistantMsg(content = "reply") {
  return msg("assistant", content);
}

function toolMsg(content: string, toolName = "some_tool") {
  return msg("tool", content, { toolCallId: `tc-${nextId++}`, toolName });
}

/** Build a conversation with enough assistants in the tail for the cutoff to work. */
function buildConversation(toolContents: string[]): SessionMessage[] {
  const messages: SessionMessage[] = [userMsg()];
  for (const tc of toolContents) {
    messages.push(assistantMsg());
    messages.push(toolMsg(tc));
  }
  // Add KEEP_LAST_ASSISTANTS assistants at the end to create a protected zone
  for (let i = 0; i < KEEP_LAST_ASSISTANTS; i++) {
    messages.push(assistantMsg(`protected-${i}`));
  }
  return messages;
}

/** Calculate the token window needed to produce a given ratio for messages. */
function tokensForRatio(messages: readonly SessionMessage[], ratio: number): number {
  const totalChars = estimateContextChars(messages);
  // ratio = totalChars / (tokens * CHARS_PER_TOKEN_ESTIMATE)
  // tokens = totalChars / (ratio * CHARS_PER_TOKEN_ESTIMATE)
  return Math.ceil(totalChars / (ratio * CHARS_PER_TOKEN_ESTIMATE));
}

/** Simulate soft-trim to compute post-trim chars, then return tokens for desired ratio. */
function tokensForRatioAfterSoftTrim(
  messages: readonly SessionMessage[],
  ratio: number,
): number {
  let totalChars = estimateContextChars(messages);
  for (const m of messages) {
    if (m.role === "tool" && m.content.length > SOFT_TRIM_MAX_CHARS) {
      const trimmed = softTrimContent(m.content, SOFT_TRIM_HEAD_CHARS, SOFT_TRIM_TAIL_CHARS);
      totalChars -= m.content.length - trimmed.length;
    }
  }
  return Math.ceil(totalChars / (ratio * CHARS_PER_TOKEN_ESTIMATE));
}

// --- Constants ---

describe("constants", () => {
  test("CHARS_PER_TOKEN_ESTIMATE is 4", () => {
    expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
  });

  test("IMAGE_CHAR_ESTIMATE is 8000", () => {
    expect(IMAGE_CHAR_ESTIMATE).toBe(8_000);
  });

  test("NON_IMAGE_CHAR_ESTIMATE is 2000", () => {
    expect(NON_IMAGE_CHAR_ESTIMATE).toBe(2_000);
  });

  test("KEEP_LAST_ASSISTANTS is 3", () => {
    expect(KEEP_LAST_ASSISTANTS).toBe(3);
  });
});

// --- estimateMessageChars ---

describe("estimateMessageChars", () => {
  test("content length only", () => {
    const m = msg("user", "abcdef");
    expect(estimateMessageChars(m)).toBe(6);
  });

  test("image attachments add IMAGE_CHAR_ESTIMATE per attachment", () => {
    const m = msg("user", "", {
      attachments: [
        { data: new Uint8Array(10), mimeType: "image/png" },
        { data: new Uint8Array(20), mimeType: "image/jpeg" },
      ],
    });
    expect(estimateMessageChars(m)).toBe(IMAGE_CHAR_ESTIMATE * 2);
  });

  test("non-image attachments add NON_IMAGE_CHAR_ESTIMATE", () => {
    const m = msg("user", "", {
      attachments: [
        { data: new Uint8Array(10), mimeType: "application/pdf" },
        { data: new Uint8Array(20), mimeType: "text/plain" },
      ],
    });
    expect(estimateMessageChars(m)).toBe(NON_IMAGE_CHAR_ESTIMATE * 2);
  });

  test("mixed image and non-image attachments", () => {
    const m = msg("user", "", {
      attachments: [
        { data: new Uint8Array(10), mimeType: "image/png" },
        { data: new Uint8Array(20), mimeType: "application/pdf" },
      ],
    });
    expect(estimateMessageChars(m)).toBe(IMAGE_CHAR_ESTIMATE + NON_IMAGE_CHAR_ESTIMATE);
  });

  test("toolCall args via JSON.stringify", () => {
    const args = { foo: "bar", n: 42 };
    const tc: ToolCall = { toolCallId: "tc-1", toolName: "t", args };
    const m = msg("assistant", "", { toolCalls: [tc] });
    expect(estimateMessageChars(m)).toBe(JSON.stringify(args).length);
  });

  test("content + attachments + toolCalls combined", () => {
    const args = { x: 1 };
    const m = msg("assistant", "hello", {
      attachments: [{ data: new Uint8Array(1), mimeType: "image/png" }],
      toolCalls: [{ toolCallId: "tc-1", toolName: "t", args }],
    });
    expect(estimateMessageChars(m)).toBe(
      5 + IMAGE_CHAR_ESTIMATE + JSON.stringify(args).length,
    );
  });

  test("empty attachments array adds zero", () => {
    const m = msg("user", "hi", { attachments: [] });
    expect(estimateMessageChars(m)).toBe(2);
  });

  test("JSON.stringify failure falls back to 128", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const tc: ToolCall = { toolCallId: "tc-1", toolName: "t", args: circular };
    const m = msg("assistant", "", { toolCalls: [tc] });
    expect(estimateMessageChars(m)).toBe(128);
  });
});

// --- estimateContextChars ---

describe("estimateContextChars", () => {
  test("sums all message chars", () => {
    const messages = [msg("user", "abc"), msg("assistant", "de")];
    expect(estimateContextChars(messages)).toBe(5);
  });

  test("empty array returns 0", () => {
    expect(estimateContextChars([])).toBe(0);
  });
});

// --- findAssistantCutoffIndex ---

describe("findAssistantCutoffIndex", () => {
  test("returns index of Nth-from-last assistant", () => {
    const messages = [
      userMsg(),
      assistantMsg("a1"),
      toolMsg("r1"),
      assistantMsg("a2"),
      toolMsg("r2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    // Walking backward: a4 (idx 6) = 1st, a3 (idx 5) = 2nd, a2 (idx 3) = 3rd
    expect(findAssistantCutoffIndex(messages, 3)).toBe(3);
  });

  test("returns null if fewer than keepLastAssistants", () => {
    const messages = [userMsg(), assistantMsg(), assistantMsg()];
    expect(findAssistantCutoffIndex(messages, 3)).toBeNull();
  });

  test("keepLastAssistants <= 0 returns messages.length", () => {
    const messages = [userMsg(), assistantMsg()];
    expect(findAssistantCutoffIndex(messages, 0)).toBe(messages.length);
    expect(findAssistantCutoffIndex(messages, -1)).toBe(messages.length);
  });
});

// --- findFirstUserIndex ---

describe("findFirstUserIndex", () => {
  test("returns first user index", () => {
    const messages = [assistantMsg(), userMsg(), assistantMsg()];
    expect(findFirstUserIndex(messages)).toBe(1);
  });

  test("returns null if no user messages", () => {
    const messages = [assistantMsg(), assistantMsg()];
    expect(findFirstUserIndex(messages)).toBeNull();
  });
});

// --- softTrimContent ---

describe("softTrimContent", () => {
  test("returns content unchanged if short enough", () => {
    const content = "short";
    expect(softTrimContent(content, 1500, 1500)).toBe(content);
  });

  test("trims long content with head + tail + annotation", () => {
    const content = "A".repeat(5000);
    const trimmed = softTrimContent(content, 1500, 1500);
    expect(trimmed.startsWith("A".repeat(1500))).toBe(true);
    expect(trimmed).toContain("\n...\n");
    expect(trimmed).toContain("A".repeat(1500));
    expect(trimmed).toContain(
      `[Tool result trimmed: kept first 1500 and last 1500 chars of 5000 chars.]`,
    );
  });

  test("boundary: content length exactly head + tail returns unchanged", () => {
    const content = "X".repeat(3000);
    expect(softTrimContent(content, 1500, 1500)).toBe(content);
  });

  test("boundary: content length head + tail + 1 gets trimmed", () => {
    const content = "X".repeat(3001);
    const trimmed = softTrimContent(content, 1500, 1500);
    expect(trimmed).toContain("\n...\n");
    expect(trimmed).toContain("[Tool result trimmed:");
  });
});

// --- pruneContext: passthrough ---

describe("pruneContext passthrough", () => {
  test("ratio below soft threshold returns original messages", () => {
    const messages = buildConversation(["small tool result"]);
    // Use a huge token window so ratio is tiny
    const result = pruneContext(messages, 1_000_000);
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages); // new array
  });

  test("contextWindowTokens <= 0 returns copy", () => {
    const messages = [userMsg()];
    expect(pruneContext(messages, 0)).toEqual(messages);
    expect(pruneContext(messages, -10)).toEqual(messages);
  });

  test("empty messages returns empty array", () => {
    expect(pruneContext([], 1000)).toEqual([]);
  });

  test("no tool messages returns original", () => {
    const messages = [
      userMsg(),
      assistantMsg("a1"),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    // Even at high ratio, if there are no prunable tools nothing changes
    const result = pruneContext(messages, 1);
    expect(result).toEqual(messages);
  });
});

// --- pruneContext: soft-trim ---

describe("pruneContext soft-trim", () => {
  test("large tool result gets trimmed", () => {
    const bigContent = "X".repeat(10_000);
    const messages = buildConversation([bigContent]);
    // Need ratio >= SOFT_TRIM_RATIO
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(result[toolIdx].content).toContain("\n...\n");
    expect(result[toolIdx].content).toContain("[Tool result trimmed:");
    expect(result[toolIdx].content.length).toBeLessThan(bigContent.length);
  });

  test("small tool result is untouched", () => {
    const smallContent = "small";
    const bigContent = "Y".repeat(10_000);
    const messages = buildConversation([smallContent, bigContent]);
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    // Find the small tool message
    const smallToolIdx = messages.findIndex(
      (m) => m.role === "tool" && m.content === smallContent,
    );
    expect(result[smallToolIdx].content).toBe(smallContent);
  });

  test("stops early when ratio drops below threshold", () => {
    // Two large tool results, but only one needs trimming to drop below ratio
    const big1 = "A".repeat(50_000);
    const big2 = "B".repeat(50_000);
    const messages = buildConversation([big1, big2]);

    // Calculate a window so that trimming just the first brings ratio below SOFT_TRIM_RATIO.
    // After trimming first: saves ~47000 chars. We want ratio just above threshold before,
    // and just below after trimming one.
    const totalBefore = estimateContextChars(messages);
    const savedByOne =
      big1.length -
      softTrimContent(big1, SOFT_TRIM_HEAD_CHARS, SOFT_TRIM_TAIL_CHARS).length;
    const totalAfter = totalBefore - savedByOne;
    // We need: totalBefore/charWindow >= SOFT_TRIM_RATIO and totalAfter/charWindow < SOFT_TRIM_RATIO
    // charWindow = totalAfter / (SOFT_TRIM_RATIO - 0.01)
    const charWindow = totalAfter / (SOFT_TRIM_RATIO - 0.01);
    const tokens = Math.ceil(charWindow / CHARS_PER_TOKEN_ESTIMATE);

    const result = pruneContext(messages, tokens);

    // First tool should be trimmed
    const tool1Idx = messages.findIndex(
      (m) => m.role === "tool" && m.content === big1,
    );
    expect(result[tool1Idx].content).toContain("[Tool result trimmed:");

    // Second tool should be untouched (early stop)
    const tool2Idx = messages.findIndex(
      (m) => m.role === "tool" && m.content === big2,
    );
    expect(result[tool2Idx].content).toBe(big2);
  });
});

// --- pruneContext: hard-clear ---

describe("pruneContext hard-clear", () => {
  // Use content just under SOFT_TRIM_MAX_CHARS so soft-trim skips them,
  // keeping full content for the hard-clear totalPrunableChars check.
  const UNDER_SOFT = SOFT_TRIM_MAX_CHARS - 1; // 3999 chars

  test("ratio above hard threshold replaces with placeholder", () => {
    // 15 tool messages * 3999 chars = 59,985 > MIN_PRUNABLE_TOOL_CHARS (50k)
    const contents = Array.from({ length: 15 }, () => "Z".repeat(UNDER_SOFT));
    const messages = buildConversation(contents);
    // Token window tight enough that ratio >= HARD_CLEAR_RATIO after soft-trim (which is a no-op here)
    const tokens = tokensForRatio(messages, HARD_CLEAR_RATIO + 0.05);
    const result = pruneContext(messages, tokens);

    // First prunable tool should be hard-cleared
    const firstToolIdx = messages.findIndex((m) => m.role === "tool");
    expect(result[firstToolIdx].content).toBe(HARD_CLEAR_PLACEHOLDER);
  });

  test("hard-clear processes oldest first", () => {
    // 15 tool messages under soft-trim threshold
    const contents = Array.from({ length: 15 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(UNDER_SOFT),
    );
    const messages = buildConversation(contents);

    // Set window so that clearing a few oldest tools brings ratio below threshold
    const totalChars = estimateContextChars(messages);
    const savedPerClear = UNDER_SOFT - HARD_CLEAR_PLACEHOLDER.length;
    // After clearing 2 tools: totalChars - 2*saved
    const afterClearing2 = totalChars - 2 * savedPerClear;
    // charWindow such that afterClearing2/charWindow < HARD_CLEAR_RATIO
    const charWindow = afterClearing2 / (HARD_CLEAR_RATIO - 0.01);
    const tokens = Math.ceil(charWindow / CHARS_PER_TOKEN_ESTIMATE);

    const result = pruneContext(messages, tokens);

    // Find all tool indices in order
    const toolIdxs = messages
      .map((m, i) => (m.role === "tool" ? i : -1))
      .filter((i) => i >= 0);

    // First two tools should be hard-cleared (oldest first)
    expect(result[toolIdxs[0]].content).toBe(HARD_CLEAR_PLACEHOLDER);
    expect(result[toolIdxs[1]].content).toBe(HARD_CLEAR_PLACEHOLDER);
    // Third tool should NOT be hard-cleared (ratio dropped)
    expect(result[toolIdxs[2]].content).not.toBe(HARD_CLEAR_PLACEHOLDER);
  });

  test("skips hard-clear if totalPrunableChars < MIN_PRUNABLE_TOOL_CHARS", () => {
    // Use tool content that is above SOFT_TRIM_MAX_CHARS but total < MIN_PRUNABLE_TOOL_CHARS after soft-trim
    const mediumContent = "M".repeat(5_000);
    const messages = buildConversation([mediumContent]);
    // Even at high ratio, hard-clear should skip because prunable chars (post-soft-trim ~3085) < 50k
    const tokens = tokensForRatioAfterSoftTrim(messages, HARD_CLEAR_RATIO + 0.1);
    const result = pruneContext(messages, tokens);

    const toolIdx = messages.findIndex((m) => m.role === "tool");
    // Should be soft-trimmed but NOT hard-cleared
    expect(result[toolIdx].content).not.toBe(HARD_CLEAR_PLACEHOLDER);
    expect(result[toolIdx].content).toContain("[Tool result trimmed:");
  });

  test("stops hard-clear when ratio drops below threshold", () => {
    // 20 tool messages under soft-trim threshold (total = 20*3999 = 79,980 > 50k)
    const contents = Array.from({ length: 20 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(UNDER_SOFT),
    );
    const messages = buildConversation(contents);

    const totalChars = estimateContextChars(messages);
    const savedPerClear = UNDER_SOFT - HARD_CLEAR_PLACEHOLDER.length;
    // After clearing 5 tools
    const afterClearing5 = totalChars - 5 * savedPerClear;
    // charWindow: clearing 5 brings ratio just below HARD_CLEAR_RATIO
    const charWindow = afterClearing5 / (HARD_CLEAR_RATIO - 0.01);
    const tokens = Math.ceil(charWindow / CHARS_PER_TOKEN_ESTIMATE);

    const result = pruneContext(messages, tokens);

    // Find all tool indices
    const toolIdxs = messages
      .map((m, i) => (m.role === "tool" ? i : -1))
      .filter((i) => i >= 0);

    // First 5 should be cleared
    for (let i = 0; i < 5; i++) {
      expect(result[toolIdxs[i]].content).toBe(HARD_CLEAR_PLACEHOLDER);
    }
    // 6th tool should not be cleared (ratio dropped)
    expect(result[toolIdxs[5]].content).not.toBe(HARD_CLEAR_PLACEHOLDER);
  });
});

// --- pruneContext: aggressive mode ---

describe("pruneContext aggressive mode", () => {
  test("zeroes all thresholds — prunes even small ratios", () => {
    const bigContent = "X".repeat(10_000);
    const messages = buildConversation([bigContent]);
    // Large window — ratio is small, normally would pass through
    const tokens = 1_000_000;
    const result = pruneContext(messages, tokens, true);

    const toolIdx = messages.findIndex((m) => m.role === "tool");
    // With aggressive, even at low ratio, soft-trim and hard-clear run
    expect(result[toolIdx].content).toBe(HARD_CLEAR_PLACEHOLDER);
  });

  test("works on context normal mode would skip", () => {
    const content = "Y".repeat(5_000);
    const messages = buildConversation([content]);
    // Very large window — ratio well below SOFT_TRIM_RATIO
    const tokens = 10_000_000;

    const normalResult = pruneContext(messages, tokens, false);
    const aggressiveResult = pruneContext(messages, tokens, true);

    const toolIdx = messages.findIndex((m) => m.role === "tool");
    // Normal: no change
    expect(normalResult[toolIdx].content).toBe(content);
    // Aggressive: hard-cleared
    expect(aggressiveResult[toolIdx].content).toBe(HARD_CLEAR_PLACEHOLDER);
  });
});

// --- pruneContext: protected zone ---

describe("pruneContext protected zone", () => {
  test("last 3 assistant messages are untouched", () => {
    const bigContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg("old"),
      toolMsg(bigContent),
      assistantMsg("p1"),
      toolMsg(bigContent),
      assistantMsg("p2"),
      toolMsg(bigContent),
      assistantMsg("p3"),
    ];
    // cutoff should be at "p1" (index 3) — 3rd from last assistant
    // Only tool at index 2 is prunable (before cutoff)
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    // Tool at index 2 (before cutoff) — should be trimmed
    expect(result[2].content).toContain("[Tool result trimmed:");
    // Tools at index 4 and 6 (after cutoff) — untouched
    expect(result[4].content).toBe(bigContent);
    expect(result[6].content).toBe(bigContent);
  });

  test("fewer than 3 assistants means nothing pruned", () => {
    const bigContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg(),
      toolMsg(bigContent),
      assistantMsg(),
    ];
    // Only 2 assistants — cutoff is null
    const result = pruneContext(messages, 1);
    expect(result).toEqual(messages);
  });
});

// --- pruneContext: first user index ---

describe("pruneContext first user index", () => {
  test("never prunes before first user message", () => {
    // System-like messages before first user (using assistant role since there's no system role)
    const bigContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      msg("tool", bigContent, { toolCallId: "pre-tc", toolName: "setup" }),
      userMsg(),
      assistantMsg("a1"),
      toolMsg(bigContent),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    // Tool at index 0 (before first user) — untouched
    expect(result[0].content).toBe(bigContent);
    // Tool at index 3 (after first user, before cutoff) — trimmed
    expect(result[3].content).toContain("[Tool result trimmed:");
  });

  test("returns as-is if no user messages", () => {
    const messages: SessionMessage[] = [
      assistantMsg(),
      assistantMsg(),
      assistantMsg(),
      assistantMsg(),
    ];
    const result = pruneContext(messages, 1);
    expect(result).toEqual(messages);
  });
});

// --- pruneContext: immutability ---

describe("pruneContext immutability", () => {
  test("modified messages are new objects", () => {
    const bigContent = "X".repeat(10_000);
    const messages = buildConversation([bigContent]);
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(result[toolIdx]).not.toBe(messages[toolIdx]);
  });

  test("untouched messages are same refs", () => {
    const bigContent = "X".repeat(10_000);
    const messages = buildConversation([bigContent]);
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);

    // User message at index 0 should be same ref
    expect(result[0]).toBe(messages[0]);
  });

  test("original array is not mutated", () => {
    const bigContent = "X".repeat(10_000);
    const messages = buildConversation([bigContent]);
    const originalContents = messages.map((m) => m.content);
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    pruneContext(messages, tokens);

    // All original messages should still have their original content
    messages.forEach((m, i) => {
      expect(m.content).toBe(originalContents[i]);
    });
  });
});

// --- pruneContext: edge cases ---

describe("pruneContext edge cases", () => {
  test("empty array", () => {
    expect(pruneContext([], 1000)).toEqual([]);
  });

  test("single user message", () => {
    const messages = [userMsg()];
    expect(pruneContext(messages, 1)).toEqual(messages);
  });

  test("no tool messages", () => {
    const messages = [
      userMsg(),
      assistantMsg("a1"),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    const result = pruneContext(messages, 1);
    expect(result).toEqual(messages);
  });

  test("all tools in protected zone", () => {
    const bigContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg("a1"),
      assistantMsg("a2"),
      toolMsg(bigContent), // after a2 (cutoff would be at a2 with 3 assistants from end)
      assistantMsg("a3"),
      toolMsg(bigContent),
      assistantMsg("a4"),
    ];
    // cutoff at a2 (index 2). Tool at index 3 is after cutoff, tool at 5 is after cutoff.
    // No prunable tools.
    const tokens = tokensForRatio(messages, SOFT_TRIM_RATIO + 0.01);
    const result = pruneContext(messages, tokens);
    expect(result[3].content).toBe(bigContent);
    expect(result[5].content).toBe(bigContent);
  });

  test("only 1 assistant — cutoff is null, nothing pruned", () => {
    const bigContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg(),
      toolMsg(bigContent),
    ];
    const result = pruneContext(messages, 1);
    expect(result).toEqual(messages);
  });
});

// --- pruneContext: skill protection ---

describe("pruneContext skill protection", () => {
  test("tool message with toolName 'skill' → never pruned even in aggressive mode", () => {
    const skillContent = "X".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg("a1"),
      toolMsg(skillContent, "skill"),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    // Aggressive mode would normally hard-clear everything
    const result = pruneContext(messages, 1, true);

    const skillIdx = messages.findIndex((m) => m.role === "tool" && m.toolName === "skill");
    expect(result[skillIdx].content).toBe(skillContent);
  });

  test("tool message with other toolName → pruned normally", () => {
    const otherContent = "Y".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg("a1"),
      toolMsg(otherContent, "search"),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
    ];
    const result = pruneContext(messages, 1, true);

    const toolIdx = messages.findIndex((m) => m.role === "tool" && m.toolName === "search");
    expect(result[toolIdx].content).not.toBe(otherContent);
  });

  test("mixed skill + non-skill tools → only non-skill pruned", () => {
    const bigContent = "Z".repeat(10_000);
    const messages: SessionMessage[] = [
      userMsg(),
      assistantMsg("a1"),
      toolMsg(bigContent, "skill"),
      assistantMsg("a2"),
      toolMsg(bigContent, "search"),
      assistantMsg("a3"),
      assistantMsg("a4"),
      assistantMsg("a5"),
    ];
    const result = pruneContext(messages, 1, true);

    // skill tool should be untouched
    const skillIdx = messages.findIndex((m) => m.role === "tool" && m.toolName === "skill");
    expect(result[skillIdx].content).toBe(bigContent);

    // search tool should be pruned
    const searchIdx = messages.findIndex((m) => m.role === "tool" && m.toolName === "search");
    expect(result[searchIdx].content).not.toBe(bigContent);
  });
});

// --- isContextLengthError ---

describe("isContextLengthError", () => {
  const patterns = [
    "resource_exhausted",
    "context_length_exceeded",
    "maximum context length",
    "too many tokens",
    "request too large",
    "request_too_large",
    "request size exceeds",
    "prompt is too long",
    "exceeds model context window",
    "content_too_large",
    "token limit",
    "context window",
  ];

  for (const pattern of patterns) {
    test(`detects pattern: "${pattern}"`, () => {
      expect(isContextLengthError(new Error(`Some ${pattern} error`))).toBe(true);
    });
  }

  test("case insensitive", () => {
    expect(isContextLengthError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isContextLengthError(new Error("Context_Length_Exceeded"))).toBe(true);
    expect(isContextLengthError(new Error("TOO MANY TOKENS"))).toBe(true);
  });

  test("false for unrelated error", () => {
    expect(isContextLengthError(new Error("network timeout"))).toBe(false);
    expect(isContextLengthError(new Error("internal server error"))).toBe(false);
  });

  test("handles string input", () => {
    expect(isContextLengthError("resource_exhausted")).toBe(true);
    expect(isContextLengthError("something else")).toBe(false);
  });

  test("handles non-Error non-string input", () => {
    expect(isContextLengthError(42)).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError(undefined)).toBe(false);
    expect(isContextLengthError({})).toBe(false);
  });
});
