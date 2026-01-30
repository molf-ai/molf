import { describe, expect, test } from "bun:test";
import { Session } from "../src/session.js";
import type { SerializedSession } from "../src/session.js";

describe("Session serialization", () => {
  test("serialize returns a plain object with messages", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Hello" });
    session.addMessage({ role: "assistant", content: "Hi there" });

    const serialized = session.serialize();

    expect(serialized.messages).toHaveLength(2);
    expect(serialized.messages[0].role).toBe("user");
    expect(serialized.messages[0].content).toBe("Hello");
    expect(serialized.messages[1].role).toBe("assistant");
    expect(serialized.messages[1].content).toBe("Hi there");
  });

  test("serialize returns independent copy of messages", () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Test" });

    const serialized = session.serialize();

    // Mutating serialized data should not affect original session
    serialized.messages[0].content = "Modified";
    expect(session.getMessages()[0].content).toBe("Test");
  });

  test("serialize empty session returns empty messages array", () => {
    const session = new Session();
    const serialized = session.serialize();

    expect(serialized.messages).toEqual([]);
  });

  test("deserialize reconstructs a Session from serialized data", () => {
    const data: SerializedSession = {
      messages: [
        { id: "msg_1", role: "user", content: "Hello", timestamp: 1000 },
        { id: "msg_2", role: "assistant", content: "Hi", timestamp: 2000 },
      ],
    };

    const session = Session.deserialize(data);

    expect(session.length).toBe(2);
    expect(session.getMessages()[0].id).toBe("msg_1");
    expect(session.getMessages()[0].content).toBe("Hello");
    expect(session.getMessages()[1].id).toBe("msg_2");
    expect(session.getMessages()[1].content).toBe("Hi");
  });

  test("deserialize creates independent copy", () => {
    const data: SerializedSession = {
      messages: [
        { id: "msg_1", role: "user", content: "Test", timestamp: 1000 },
      ],
    };

    const session = Session.deserialize(data);

    // Mutating original data should not affect session
    data.messages[0].content = "Modified";
    expect(session.getMessages()[0].content).toBe("Test");
  });

  test("round-trip: serialize then deserialize produces equivalent session", () => {
    const original = new Session();
    original.addMessage({ role: "user", content: "First" });
    original.addMessage({ role: "assistant", content: "Second" });
    original.addMessage({
      role: "assistant",
      content: "With tools",
      toolCalls: [
        { id: "tc_1", type: "function" as const, function: { name: "test", arguments: "{}" } },
      ],
    });
    original.addMessage({
      role: "tool",
      content: "Result",
      toolCallId: "tc_1",
    });

    const serialized = original.serialize();
    const restored = Session.deserialize(serialized);

    expect(restored.length).toBe(original.length);

    const origMsgs = original.getMessages();
    const restMsgs = restored.getMessages();

    for (let i = 0; i < origMsgs.length; i++) {
      expect(restMsgs[i].id).toBe(origMsgs[i].id);
      expect(restMsgs[i].role).toBe(origMsgs[i].role);
      expect(restMsgs[i].content).toBe(origMsgs[i].content);
      expect(restMsgs[i].timestamp).toBe(origMsgs[i].timestamp);
    }
  });

  test("deserialized session can be used with addMessage", () => {
    const data: SerializedSession = {
      messages: [
        { id: "msg_1", role: "user", content: "Hello", timestamp: 1000 },
      ],
    };

    const session = Session.deserialize(data);
    session.addMessage({ role: "assistant", content: "World" });

    expect(session.length).toBe(2);
    expect(session.getLastMessage()?.content).toBe("World");
  });

  test("deserialized session can be converted to model messages", () => {
    const data: SerializedSession = {
      messages: [
        { id: "msg_1", role: "user", content: "Hello", timestamp: 1000 },
        { id: "msg_2", role: "assistant", content: "Hi", timestamp: 2000 },
      ],
    };

    const session = Session.deserialize(data);
    const modelMessages = session.toModelMessages();

    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[0]).toEqual({ role: "user", content: "Hello" });
    expect(modelMessages[1]).toEqual({ role: "assistant", content: "Hi" });
  });
});
