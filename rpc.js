import { Rpc } from "@opencode/plugin/rpc";

const latest = {
  type: "object",
  properties: {
    model: { type: "string" },
    sessionID: { type: "string" },
    variant: { type: "string" },
    at: { type: "number" },
  },
  required: ["model", "at"],
  additionalProperties: false,
};

const error = {
  type: "object",
  properties: {
    at: { type: "number" },
    type: { type: "string" },
    message: { type: "string" },
    status: { type: "number" },
    attempt: { type: "number" },
  },
  required: ["at", "type", "message"],
  additionalProperties: false,
};

const model = {
  type: "object",
  properties: {
    lastUsedAt: { type: "number" },
    sessionID: { type: "string" },
    variant: { type: "string" },
    lastError: error,
  },
  additionalProperties: false,
};

const status = {
  type: "object",
  properties: {
    latest,
    models: { type: "object", additionalProperties: model },
    mappings: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["models", "mappings"],
  additionalProperties: false,
};

export const ModelFallback = Rpc.define({
  id: "model-fallback",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
    },
  },
  events: {
    updated: { schema: status },
  },
});
