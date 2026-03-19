import { vi, type Mock } from "vitest";

export interface MockApiResult {
  api: Record<string, Mock>;
  sentMessages: Array<{ chatId: number; text: string; opts?: any; messageId: number }>;
  editedMessages: Array<{ chatId: number; messageId: number; text: string; opts?: any }>;
  editedMarkups: Array<{ chatId: number; messageId: number; opts?: any }>;
  chatActions: Array<{ chatId: number; action: string }>;
  reactions: Array<{ chatId: number; messageId: number; reaction: any }>;
  callbackAnswers: string[];
}

/** Create a mock grammY Api object that records all calls. */
export function createMockApi(): MockApiResult {
  const sentMessages: MockApiResult["sentMessages"] = [];
  const editedMessages: MockApiResult["editedMessages"] = [];
  const editedMarkups: MockApiResult["editedMarkups"] = [];
  const chatActions: MockApiResult["chatActions"] = [];
  const reactions: MockApiResult["reactions"] = [];
  const callbackAnswers: string[] = [];

  let nextMessageId = 1000;

  const api = {
    sendMessage: vi.fn(async (chatId: number, text: string, opts?: any) => {
      const msgId = nextMessageId++;
      sentMessages.push({ chatId, text, opts, messageId: msgId });
      return { message_id: msgId };
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, opts?: any) => {
      editedMessages.push({ chatId, messageId, text, opts });
      return true;
    }),
    sendChatAction: vi.fn(async (chatId: number, action: string) => {
      chatActions.push({ chatId, action });
    }),
    setMessageReaction: vi.fn(async (chatId: number, messageId: number, reaction: any) => {
      reactions.push({ chatId, messageId, reaction });
    }),
    answerCallbackQuery: vi.fn(async (id: string) => {
      callbackAnswers.push(id);
    }),
    editMessageReplyMarkup: vi.fn(async (chatId: number, messageId: number, opts?: any) => {
      editedMarkups.push({ chatId, messageId, opts });
      return true;
    }),
    getFile: vi.fn(async (fileId: string) => ({
      file_id: fileId,
      file_path: `photos/${fileId}.jpg`,
    })),
  };

  return { api, sentMessages, editedMessages, editedMarkups, chatActions, reactions, callbackAnswers };
}
