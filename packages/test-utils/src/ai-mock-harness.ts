import { mock } from "bun:test";

let streamTextImpl: (...args: any[]) => any = () => {
  throw new Error("streamTextImpl not set — assign it in beforeEach");
};

let generateTextImpl: (...args: any[]) => any = () =>
  Promise.resolve({ text: "" });

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  generateText: (...args: any[]) => generateTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

export function setStreamTextImpl(impl: (...args: any[]) => any): void {
  streamTextImpl = impl;
}

export function setGenerateTextImpl(impl: (...args: any[]) => any): void {
  generateTextImpl = impl;
}
