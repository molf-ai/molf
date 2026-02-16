export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  arguments: string;
  result?: string;
}

export interface CompletedToolCallGroup {
  assistantMessageId: string;
  toolCalls: ToolCallInfo[];
}

/** Local-only message type that extends SessionMessage with a system role */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  attachments?: { mimeType: string; filename?: string }[];
  toolCalls?: { toolCallId: string; toolName: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  timestamp: number;
}
