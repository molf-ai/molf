import { describe, test, expect, mock, beforeEach, spyOn, afterEach } from "bun:test";
import { type LogRecord, configure, reset } from "@logtape/logtape";

// --- Mock setup BEFORE imports (CLAUDE.md critical convention) ---

let mockClientInstances: MockClient[] = [];
let mockTransportInstances: Array<MockTransport | MockHttpTransport> = [];
let failingCommands = new Set<string>();
let failingHttpUrls = new Set<string>();

class MockTransport {
  command: string;
  args: string[];
  env: Record<string, string>;
  pid: number | null = Math.floor(Math.random() * 10000);
  closed = false;

  constructor(opts: { command: string; args?: string[]; env?: Record<string, string>; stderr?: string }) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env ?? {};
    mockTransportInstances.push(this);
  }

  async close() {
    this.closed = true;
  }
}

class MockHttpTransport {
  url: URL;
  headers: Record<string, string>;
  closed = false;

  constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
    this.url = url;
    this.headers = opts?.requestInit?.headers ?? {};
    mockTransportInstances.push(this);
  }

  async close() {
    this.closed = true;
  }
}

class MockClient {
  info: { name: string; version: string };
  connected = false;
  transport: MockTransport | MockHttpTransport | null = null;
  connectDelay = 0;
  shouldFailConnect = false;
  toolsResponse: any = { tools: [] };
  callToolResponse: any = { content: [] };
  notificationHandlers: Map<any, any> = new Map();
  onclose: (() => void) | undefined = undefined;

  constructor(info: { name: string; version: string }) {
    this.info = info;
    mockClientInstances.push(this);
  }

  async connect(transport: MockTransport | MockHttpTransport) {
    if (this.connectDelay > 0) {
      await new Promise((r) => setTimeout(r, this.connectDelay));
    }
    if (
      this.shouldFailConnect ||
      (transport instanceof MockTransport && failingCommands.has(transport.command)) ||
      (transport instanceof MockHttpTransport && failingHttpUrls.has(transport.url.toString()))
    ) {
      throw new Error("Connection refused");
    }
    this.connected = true;
    this.transport = transport;
  }

  async listTools() {
    return this.toolsResponse;
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return this.callToolResponse;
  }

  setNotificationHandler(schema: any, handler: any) {
    this.notificationHandlers.set(schema, handler);
  }

  async close() {
    this.connected = false;
  }

  simulateDisconnect() {
    this.connected = false;
    this.onclose?.();
  }
}

mock.module("@modelcontextprotocol/sdk/client", () => ({
  Client: MockClient,
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockTransport,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockHttpTransport,
}));

mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  ToolListChangedNotificationSchema: "ToolListChangedNotification",
}));

// --- Now import the module under test ---
const { McpClientManager, createServerCaller } = await import("../../src/mcp/client.js");

beforeEach(() => {
  mockClientInstances = [];
  mockTransportInstances = [];
  failingCommands.clear();
  failingHttpUrls.clear();
});

describe("McpClientManager.connectAll", () => {
  test("connects to all stdio servers in parallel", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      serverA: { type: "stdio", command: "echo", args: ["a"], env: {} },
      serverB: { type: "stdio", command: "echo", args: ["b"], env: {} },
    });

    expect(manager.getConnectedServers()).toEqual(["serverA", "serverB"]);
    expect(mockClientInstances).toHaveLength(2);
    expect(mockClientInstances.every((c) => c.connected)).toBe(true);
  });

  test("failed server is skipped, others continue", async () => {
    failingCommands.add("bad");
    const manager = new McpClientManager();

    await manager.connectAll({
      failing: { type: "stdio", command: "bad", args: [], env: {} },
      working: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const servers = manager.getConnectedServers();
    expect(servers).not.toContain("failing");
    expect(servers).toContain("working");
  });

  test("empty config does nothing", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({});
    expect(manager.getConnectedServers()).toEqual([]);
  });

  test("connects to http server", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      github: { type: "http", url: "http://example.com/mcp", headers: {} },
    });

    expect(manager.getConnectedServers()).toContain("github");
    expect(mockTransportInstances).toHaveLength(1);
    const transport = mockTransportInstances[0] as MockHttpTransport;
    expect(transport).toBeInstanceOf(MockHttpTransport);
    expect(transport.url.toString()).toBe("http://example.com/mcp");
  });

  test("passes headers to http transport", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      api: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    });

    const transport = mockTransportInstances[0] as MockHttpTransport;
    expect(transport).toBeInstanceOf(MockHttpTransport);
    expect(transport.headers.Authorization).toBe("Bearer secret");
  });

  test("mixes stdio and http servers", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      local: { type: "stdio", command: "echo", args: [], env: {} },
      remote: { type: "http", url: "http://example.com/mcp", headers: {} },
    });

    expect(manager.getConnectedServers()).toContain("local");
    expect(manager.getConnectedServers()).toContain("remote");
    expect(mockTransportInstances).toHaveLength(2);
    const stdioTransport = mockTransportInstances.find(t => t instanceof MockTransport);
    const httpTransport = mockTransportInstances.find(t => t instanceof MockHttpTransport);
    expect(stdioTransport).toBeDefined();
    expect(httpTransport).toBeDefined();
  });
});

describe("McpClientManager.listTools", () => {
  test("returns tool definitions from server", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    // Set the response on the mock client
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.toolsResponse = {
      tools: [
        {
          name: "read",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };

    const tools = await manager.listTools("srv");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read");
    expect(tools[0].description).toBe("Read file");
  });

  test("throws for unknown server", async () => {
    const manager = new McpClientManager();
    await expect(manager.listTools("nonexistent")).rejects.toThrow("not connected");
  });
});

describe("McpClientManager.callTool", () => {
  test("routes to correct server", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callToolResponse = {
      content: [{ type: "text", text: "result" }],
    };

    const result = await manager.callTool("srv", "echo", { message: "hi" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "result" });
  });

  test("throws for unknown server", async () => {
    const manager = new McpClientManager();
    await expect(manager.callTool("nonexistent", "tool", {})).rejects.toThrow("not connected");
  });

  test("malformed response with no content returns empty array", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callToolResponse = {};

    const result = await manager.callTool("srv", "tool", {});
    expect(result.content).toEqual([]);
    expect(result.isError).toBe(false);
  });

  test("malformed response with null content returns empty array", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callToolResponse = { content: null };

    const result = await manager.callTool("srv", "tool", {});
    expect(result.content).toEqual([]);
    expect(result.isError).toBe(false);
  });

  test("error message says 'offline — reconnecting' after disconnect", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      const client = mockClientInstances[mockClientInstances.length - 1];
      client.simulateDisconnect();

      await expect(manager.callTool("srv", "tool", {})).rejects.toThrow(
        "offline — reconnecting",
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("error message says 'not connected' for never-connected server", async () => {
    const manager = new McpClientManager();
    await expect(manager.callTool("unknown", "tool", {})).rejects.toThrow(
      "not connected",
    );
  });
});

describe("McpClientManager.closeAll", () => {
  test("closes all transports and clears map", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      a: { type: "stdio", command: "echo", args: [], env: {} },
      b: { type: "stdio", command: "echo", args: [], env: {} },
    });

    expect(manager.getConnectedServers()).toHaveLength(2);

    await manager.closeAll();
    expect(manager.getConnectedServers()).toHaveLength(0);
    // Transports should be closed
    expect(mockTransportInstances.every((t) => t.closed)).toBe(true);
  });

  test("connections map is not cleared until transports are closed", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    // Make transport.close() async to verify ordering
    const transport = mockTransportInstances[mockTransportInstances.length - 1];
    let connectedDuringClose = false;
    const originalClose = transport.close.bind(transport);
    transport.close = async () => {
      // During close, the connections map should still have the entry
      connectedDuringClose = manager.getConnectedServers().includes("srv");
      await originalClose();
    };

    await manager.closeAll();

    // Verify the connection was still in the map during transport close
    expect(connectedDuringClose).toBe(true);
    // And is cleared after
    expect(manager.getConnectedServers()).toHaveLength(0);
  });
});

describe("createServerCaller", () => {
  test("delegates callTool to manager for specific server", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callToolResponse = {
      content: [{ type: "text", text: "delegated" }],
    };

    const caller = createServerCaller(manager, "srv");
    const result = await caller.callTool("echo", { message: "test" });
    expect(result.content).toHaveLength(1);
  });
});

describe("McpClientManager — enabled flag", () => {
  test("server with enabled:false is skipped", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      disabled: { type: "stdio", command: "echo", args: [], env: {}, enabled: false },
      active: { type: "stdio", command: "echo", args: [], env: {} },
    });
    expect(manager.getConnectedServers()).not.toContain("disabled");
    expect(manager.getConnectedServers()).toContain("active");
  });

  test("enabled:false logs skip message", async () => {
    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      const manager = new McpClientManager();
      await manager.connectAll({
        skipped: { type: "stdio", command: "echo", args: [], env: {}, enabled: false },
      });
      const skipRecord = buffer.find((r) => r.message.some((m) => typeof m === "string" && m.includes("disabled")));
      expect(skipRecord).toBeTruthy();
    } finally {
      await reset();
    }
  });
});

describe("McpClientManager — ToolListChanged", () => {
  test("onToolsChanged callback is called when notification fires", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({ srv: { type: "stdio", command: "echo", args: [], env: {} } });

    let callbackServer = "";
    manager.onToolsChanged = (serverName: string) => { callbackServer = serverName; };

    // Simulate notification by calling the handler directly
    const client = mockClientInstances[mockClientInstances.length - 1];
    const handler = Array.from(client.notificationHandlers.values())[0];
    if (handler) await handler();

    expect(callbackServer).toBe("srv");
  });
});

describe("McpClientManager — reconnect", () => {
  test("client.onclose triggers scheduleReconnect (timer is scheduled)", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      const client = mockClientInstances[mockClientInstances.length - 1];
      client.simulateDisconnect();

      expect(timers.some((t) => t.delay === 1000)).toBe(true);
      expect(manager.getConnectedServers()).not.toContain("srv");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("successful reconnect fires onToolsChanged", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    let changedServer = "";
    manager.onToolsChanged = (name: string) => { changedServer = name; };

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      const client = mockClientInstances[mockClientInstances.length - 1];
      client.simulateDisconnect();

      await timers.find((t) => t.delay === 1000)!.cb();

      expect(manager.getConnectedServers()).toContain("srv");
      expect(changedServer).toBe("srv");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("closeAll before timer fires cancels reconnect and prevents attempt", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const timers: Array<{ cb: (...args: any[]) => any; delay: number; id: number }> = [];
    const clearedIds: number[] = [];
    let nextId = 1;

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        const id = nextId++;
        timers.push({ cb, delay, id });
        return id as any;
      },
    );
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation((id: any) => {
      clearedIds.push(id);
    });

    const client = mockClientInstances[mockClientInstances.length - 1];
    client.simulateDisconnect();

    try {
      const reconnectTimer = timers.find((t) => t.delay === 1000)!;
      await manager.closeAll();

      expect(clearedIds).toContain(reconnectTimer.id);

      // Firing the timer after closeAll should not create a new connection
      const connsBefore = mockClientInstances.length;
      await reconnectTimer.cb();
      expect(mockClientInstances.length).toBe(connsBefore);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test("failed reconnect schedules retry with 1.5× delay", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    // Make future connect attempts fail
    failingCommands.add("echo");

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      const client = mockClientInstances[mockClientInstances.length - 1];
      client.simulateDisconnect();

      await timers.find((t) => t.delay === 1000)!.cb();

      // Retry timer should be at 1.5× the initial delay (1500ms)
      expect(timers.some((t) => t.delay === 1500)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("stale onclose (old client !== conn.client) does not trigger reconnect", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      srv: { type: "stdio", command: "echo", args: [], env: {} },
    });

    const oldClient = mockClientInstances[mockClientInstances.length - 1];

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      // First disconnect + reconnect — new client is now in the map
      oldClient.simulateDisconnect();
      await timers.find((t) => t.delay === 1000)!.cb();

      // Old client fires onclose again (stale closure)
      const reconnectTimersBefore = timers.filter((t) => t.delay === 1000).length;
      oldClient.onclose?.();
      expect(timers.filter((t) => t.delay === 1000).length).toBe(reconnectTimersBefore);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("reconnect with HTTP transport re-establishes connection", async () => {
    const manager = new McpClientManager();
    await manager.connectAll({
      api: { type: "http", url: "http://example.com/mcp", headers: { "X-Key": "abc" } },
    });

    expect(manager.getConnectedServers()).toContain("api");
    const client = mockClientInstances[mockClientInstances.length - 1];

    let changedServer = "";
    manager.onToolsChanged = (name: string) => { changedServer = name; };

    const timers: Array<{ cb: (...args: any[]) => any; delay: number }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (cb: any, delay: any) => {
        timers.push({ cb, delay });
        return timers.length as any;
      },
    );

    try {
      // Disconnect the HTTP server
      client.simulateDisconnect();
      expect(manager.getConnectedServers()).not.toContain("api");

      // Trigger reconnect
      await timers.find((t) => t.delay === 1000)!.cb();

      expect(manager.getConnectedServers()).toContain("api");
      expect(changedServer).toBe("api");

      // Verify a new HTTP transport was created
      const httpTransports = mockTransportInstances.filter(t => t instanceof MockHttpTransport);
      expect(httpTransports.length).toBeGreaterThanOrEqual(2); // original + reconnect
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("McpClientManager — listTools after partial connect failure", () => {
  test("listTools works for connected server when another server failed", async () => {
    failingCommands.add("bad-cmd");
    const manager = new McpClientManager();
    await manager.connectAll({
      failing: { type: "stdio", command: "bad-cmd", args: [], env: {} },
      working: { type: "stdio", command: "echo", args: [], env: {} },
    });

    // working server should be connected
    expect(manager.getConnectedServers()).toContain("working");
    expect(manager.getConnectedServers()).not.toContain("failing");

    // Set tools on the working server's client
    const workingClient = mockClientInstances.find(c => c.connected);
    expect(workingClient).toBeDefined();
    workingClient!.toolsResponse = {
      tools: [{ name: "test_tool", description: "A tool", inputSchema: {} }],
    };

    const tools = await manager.listTools("working");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("test_tool");
  });

  test("listTools throws for server that failed to connect", async () => {
    failingCommands.add("bad-cmd");
    const manager = new McpClientManager();
    await manager.connectAll({
      failing: { type: "stdio", command: "bad-cmd", args: [], env: {} },
    });

    await expect(manager.listTools("failing")).rejects.toThrow("not connected");
  });

  test("listTools throws for partially-connected server (HTTP fail)", async () => {
    failingHttpUrls.add("http://broken.example.com/mcp");
    const manager = new McpClientManager();
    await manager.connectAll({
      broken: { type: "http", url: "http://broken.example.com/mcp", headers: {} },
      working: { type: "stdio", command: "echo", args: [], env: {} },
    });

    expect(manager.getConnectedServers()).not.toContain("broken");
    await expect(manager.listTools("broken")).rejects.toThrow("not connected");

    // Working server still functional
    expect(manager.getConnectedServers()).toContain("working");
  });
});

