/** Combined format: "anthropic/claude-sonnet-4-20250514" */
export type ModelId = string;

/** Split format used internally */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Parse "anthropic/claude-sonnet-4-20250514" → { providerID, modelID } */
export function parseModelId(model: ModelId): ModelRef {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error(
      `Invalid model ID "${model}". Expected format: "provider/model-name"`,
    );
  }
  return { providerID, modelID };
}

/** Format { providerID, modelID } → "anthropic/claude-sonnet-4-20250514" */
export function formatModelId(ref: ModelRef): ModelId {
  return `${ref.providerID}/${ref.modelID}`;
}
