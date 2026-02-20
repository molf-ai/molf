import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { MessageHandler } from "../src/handler.js";

function makeTRPCError(code: string, message: string): TRPCClientError<any> {
  return new TRPCClientError(message, {
    result: { error: { data: { code }, message } },
  } as any);
}

describe("MessageHandler shell exec (! prefix)", () => {
  let handler: MessageHandler;
  let sessionMapMock: any;
  let connectionMock: any;
  let rendererMock: any;
  let apiMocks: {
    sendChatAction: ReturnType<typeof mock>;
    setMessageReaction: ReturnType<typeof mock>;
    sendDocument: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    sessionMapMock = {
      getOrCreate: mock(async () => "session-1"),
    };

    connectionMock = {
      trpc: {
        agent: {
          prompt: {
            mutate: mock(async () => ({ messageId: "msg-1" })),
          },
          shellExec: {
            mutate: mock(async () => ({
              stdout: "",
              stderr: "",
              exitCode: 0,
            })),
          },
        },
      },
    };

    rendererMock = {
      startSession: mock(() => {}),
    };

    apiMocks = {
      sendChatAction: mock(() => Promise.resolve()),
      setMessageReaction: mock(() => Promise.resolve()),
      sendDocument: mock(() => Promise.resolve()),
    };

    handler = new MessageHandler({
      sessionMap: sessionMapMock,
      connection: connectionMock,
      renderer: rendererMock,
      ackReaction: "eyes",
      botToken: "test-token",
    });
  });

  afterEach(() => {
    handler.cleanup();
  });

  function createCtx(text: string, chatId = 100) {
    return {
      chat: { id: chatId, type: "private" },
      message: { text, message_id: 1 },
      from: { id: 1234 },
      api: apiMocks,
      reply: mock(() => Promise.resolve()),
    } as any;
  }

  // 1. "!ls" routes to shellExec.mutate with saveToSession: true
  it("routes !ls to shellExec with saveToSession: true", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "file.txt",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(connectionMock.trpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      command: "ls",
      saveToSession: true,
    });
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();
  });

  // 1b. "!!ls" routes to shellExec.mutate with saveToSession: false
  it("routes !!ls to shellExec with saveToSession: false", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "file.txt",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!!ls");
    await handler.handleMessage(ctx);

    expect(connectionMock.trpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      command: "ls",
      saveToSession: false,
    });
    expect(connectionMock.trpc.agent.prompt.mutate).not.toHaveBeenCalled();
  });

  // 2. "! ls" (with space after !) strips to "ls"
  it("strips leading space: '! ls' becomes command 'ls'", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("! ls");
    await handler.handleMessage(ctx);

    expect(connectionMock.trpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      command: "ls",
      saveToSession: true,
    });
  });

  // 2b. "!! ls" (with space after !!) strips to "ls"
  it("strips leading space: '!! ls' becomes command 'ls' with saveToSession: false", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!! ls");
    await handler.handleMessage(ctx);

    expect(connectionMock.trpc.agent.shellExec.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      command: "ls",
      saveToSession: false,
    });
  });

  // 3. Bare "!" replies with usage hint text
  it("bare '!' replies with usage hint", async () => {
    const ctx = createCtx("!");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Usage: !<command>  (e.g. !ls -la)");
    expect(connectionMock.trpc.agent.shellExec.mutate).not.toHaveBeenCalled();
  });

  // 3b. Bare "!!" replies with fire-and-forget usage hint
  it("bare '!!' replies with fire-and-forget usage hint", async () => {
    const ctx = createCtx("!!");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Usage: !!<command>  (fire-and-forget, not saved to context)");
    expect(connectionMock.trpc.agent.shellExec.mutate).not.toHaveBeenCalled();
  });

  // 4. escapeHtml: stdout with "<script>" is escaped in HTML message
  it("escapes HTML in stdout", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "<script>tag</script>",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!cat index.html");
    await handler.handleMessage(ctx);

    const replyCall = ctx.reply.mock.calls[0];
    const html = replyCall[0] as string;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  // 5. Short output (≤ 3000) → ctx.reply with HTML, no sendDocument
  it("short output uses inline HTML, no document", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!echo hello");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const opts = ctx.reply.mock.calls[0][1];
    expect(opts.parse_mode).toBe("HTML");
    expect(apiMocks.sendDocument).not.toHaveBeenCalled();
  });

  // 6. Long output (> 3000) → reply with summary + sendDocument
  it("long output sends summary + document", async () => {
    const longStdout = "x".repeat(3001);
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: longStdout,
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!long-command");
    await handler.handleMessage(ctx);

    // Reply with summary
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0][1].parse_mode).toBe("HTML");
    // And send document
    expect(apiMocks.sendDocument).toHaveBeenCalledTimes(1);
    const docArgs = apiMocks.sendDocument.mock.calls[0];
    expect(docArgs[0]).toBe(100); // chatId
  });

  // 7. Summary message contains "first 10 / last 10 lines" when stdout > 20 lines
  it("summary shows 'first 10 / last 10 lines' for >20 stdout lines", async () => {
    // Each line ~30 chars * 200 lines = ~6000 chars to exceed SHELL_INLINE_LIMIT
    const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(20, "0")}`);
    const longStdout = lines.join("\n");
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: longStdout,
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!many-lines");
    await handler.handleMessage(ctx);

    const html = ctx.reply.mock.calls[0][0] as string;
    expect(html).toContain("first 10 / last 10 lines");
  });

  // 8. stdout exactly 20 lines → no "first 10 / last 10" heading
  it("stdout exactly 20 lines shows all lines inline, no truncation heading", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const stdout = lines.join("\n");
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout,
      stderr: "x".repeat(3001 - stdout.length), // push total > 3000 to trigger summary mode
      exitCode: 0,
    }));

    const ctx = createCtx("!twenty-lines");
    await handler.handleMessage(ctx);

    const html = ctx.reply.mock.calls[0][0] as string;
    expect(html).not.toContain("first 10 / last 10");
    expect(html).toContain("<b>stdout</b> (full output attached):");
  });

  // 9. buildFullOutputText: stdout containing "<" → NOT escaped (plain text)
  it("document file does not HTML-escape content", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "<html>hello</html>",
      stderr: "x".repeat(3000),
      exitCode: 0,
    }));

    const ctx = createCtx("!cat file");
    await handler.handleMessage(ctx);

    expect(apiMocks.sendDocument).toHaveBeenCalledTimes(1);
    const inputFile = apiMocks.sendDocument.mock.calls[0][1];
    // InputFile stores the buffer in .fileData
    const buf = (inputFile as any).fileData as Buffer;
    const text = buf.toString("utf-8");
    expect(text).toContain("<html>hello</html>");
    expect(text).not.toContain("&lt;html&gt;");
  });

  // 10. Long stderr (> SHELL_INLINE_LIMIT alone) → last 50 lines + "[stderr truncated, see file]"
  it("long stderr shows last 50 lines with truncation note", async () => {
    // 100 lines * ~40 chars each = ~4000 chars to exceed SHELL_INLINE_LIMIT (3000)
    const stderrLines = Array.from({ length: 100 }, (_, i) => `error-line-${String(i).padStart(25, "0")}`);
    const stderr = stderrLines.join("\n");
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "ok",
      stderr,
      exitCode: 1,
    }));

    const ctx = createCtx("!failing-cmd");
    await handler.handleMessage(ctx);

    const html = ctx.reply.mock.calls[0][0] as string;
    expect(html).toContain("[stderr truncated, see file]");
    // Should contain the last line
    expect(html).toContain("error-line-0000000000000000000000099");
    // Should NOT contain early lines (line 0-49 are omitted)
    expect(html).not.toContain("error-line-0000000000000000000000000");
  });

  // 11. PRECONDITION_FAILED → "Worker not connected..."
  it("PRECONDITION_FAILED error shows worker not connected message", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => {
      throw makeTRPCError("PRECONDITION_FAILED", "No worker");
    });

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Worker not connected. Use /worker to select a worker.");
  });

  // 12. NOT_FOUND → "Session not found..."
  it("NOT_FOUND error shows session not found message", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => {
      throw makeTRPCError("NOT_FOUND", "Session gone");
    });

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Session not found. Use /new to start a session.");
  });

  // 13. INTERNAL_SERVER_ERROR → "Shell execution failed: " + message
  it("INTERNAL_SERVER_ERROR shows shell execution failed with message", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => {
      throw makeTRPCError("INTERNAL_SERVER_ERROR", "spawn failed");
    });

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Shell execution failed: spawn failed");
  });

  // 14. Unknown error → "Something went wrong running the command."
  it("unknown error shows generic message", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => {
      throw new Error("random failure");
    });

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("Something went wrong running the command.");
  });

  // 15. CONFLICT error → agent busy message
  it("CONFLICT error shows agent busy message", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => {
      throw makeTRPCError("CONFLICT", "Agent is busy");
    });

    const ctx = createCtx("!ls");
    await handler.handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      "Agent is busy. Wait for the current operation to finish, or use !! to run without saving to context.",
    );
  });

  // 16. [saved to context] indicator when saveToSession=true
  it("shows [saved to context] when saveToSession is true", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!echo hello");
    await handler.handleMessage(ctx);

    const html = ctx.reply.mock.calls[0][0] as string;
    expect(html).toContain("[saved to context]");
  });

  // 17. No [saved to context] when saveToSession=false (!! prefix)
  it("does not show [saved to context] with !! prefix", async () => {
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }));

    const ctx = createCtx("!!echo hello");
    await handler.handleMessage(ctx);

    const html = ctx.reply.mock.calls[0][0] as string;
    expect(html).not.toContain("[saved to context]");
  });

  // 18. Tier 3: Truncated output uses fs.read to fetch full output
  it("truncated output fetches full content via fs.read and sends document", async () => {
    const truncatedPreview = "x".repeat(3001); // must exceed SHELL_INLINE_LIMIT to reach Tier 3
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: truncatedPreview,
      stderr: "",
      exitCode: 0,
      stdoutTruncated: true,
      stdoutOutputPath: "/workdir/.molf/tool-output/abc_stdout.txt",
    }));
    connectionMock.trpc.fs = {
      read: {
        mutate: mock(async () => ({
          content: "full stdout content here",
          size: 24,
          encoding: "utf-8",
        })),
      },
    };

    const ctx = createCtx("!big-command");
    await handler.handleMessage(ctx);

    // Summary reply sent
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    // fs.read called with correct path
    expect(connectionMock.trpc.fs.read.mutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      path: "/workdir/.molf/tool-output/abc_stdout.txt",
    });
    // Document sent with full content
    expect(apiMocks.sendDocument).toHaveBeenCalledTimes(1);
    const inputFile = apiMocks.sendDocument.mock.calls[0][1];
    const buf = (inputFile as any).fileData as Buffer;
    const text = buf.toString("utf-8");
    expect(text).toContain("full stdout content here");
    expect(text).not.toContain("(truncated)");
  });

  // 19. fs.read failure falls back to truncated response data
  it("fs.read failure falls back to truncated response data", async () => {
    const truncatedPreview = "x".repeat(3001); // must exceed SHELL_INLINE_LIMIT to reach Tier 3
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: truncatedPreview,
      stderr: "",
      exitCode: 0,
      stdoutTruncated: true,
      stdoutOutputPath: "/workdir/.molf/tool-output/abc_stdout.txt",
    }));
    connectionMock.trpc.fs = {
      read: {
        mutate: mock(async () => { throw new Error("Worker disconnected"); }),
      },
    };

    const ctx = createCtx("!big-command");
    await handler.handleMessage(ctx);

    // Document still sent with fallback truncated content
    expect(apiMocks.sendDocument).toHaveBeenCalledTimes(1);
    const inputFile = apiMocks.sendDocument.mock.calls[0][1];
    const buf = (inputFile as any).fileData as Buffer;
    const text = buf.toString("utf-8");
    expect(text).toContain("stdout (truncated)");
    expect(text).toContain(truncatedPreview);
  });

  // 20. Medium output (not truncated, > 3KB) uses response data for file, not fs.read
  it("medium non-truncated output sends file from response data, no fs.read", async () => {
    const longStdout = "x".repeat(3001);
    connectionMock.trpc.agent.shellExec.mutate = mock(async () => ({
      stdout: longStdout,
      stderr: "",
      exitCode: 0,
      stdoutTruncated: false,
    }));
    connectionMock.trpc.fs = {
      read: {
        mutate: mock(async () => { throw new Error("Should not be called"); }),
      },
    };

    const ctx = createCtx("!medium-command");
    await handler.handleMessage(ctx);

    // fs.read should NOT be called
    expect(connectionMock.trpc.fs.read.mutate).not.toHaveBeenCalled();
    // Document sent from response data
    expect(apiMocks.sendDocument).toHaveBeenCalledTimes(1);
  });
});
