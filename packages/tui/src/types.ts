export interface ToolCallInfo {
  toolName: string;
  arguments: string;
  result?: string;
}

export interface CompletedToolCallGroup {
  assistantMessageId: string;
  toolCalls: ToolCallInfo[];
}
