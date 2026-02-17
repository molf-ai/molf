import { mock } from "bun:test";

let streamTextImpl: (...args: any[]) => any = () => {
  throw new Error("streamTextImpl not set — assign it in beforeEach");
};

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "mock-model",
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => "mock-model",
}));

export function setStreamTextImpl(impl: (...args: any[]) => any): void {
  streamTextImpl = impl;
}
