import React from "react";
import { Static } from "ink";
import type { DisplayMessage, CompletedToolCallGroup } from "../types.js";
import { MessageItem } from "./message-item.js";

interface Props {
  messages: DisplayMessage[];
  completedToolCalls: CompletedToolCallGroup[];
}

export function ChatHistory({ messages, completedToolCalls }: Props) {
  return (
    <Static items={messages}>
      {(message) => {
        const group = completedToolCalls.find(
          (g) => g.assistantMessageId === message.id,
        );
        return (
          <MessageItem
            key={message.id}
            message={message}
            completedToolCalls={group?.toolCalls}
          />
        );
      }}
    </Static>
  );
}
