import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createMappedFallbackRouter } from "../lib/router.js";

const ORIGINAL = "openai/gpt";
const FALLBACK = "azure/gpt";

const mocks = vi.hoisted(() => ({
  store: undefined,
  abortSession: vi.fn(),
  getReplayParts: vi.fn(),
}));

vi.mock("../lib/store.js", () => ({
  createStateStore: () => mocks.store,
}));

vi.mock("../lib/session.js", () => ({
  abortSession: mocks.abortSession,
  getReplayParts: mocks.getReplayParts,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  mocks.store = createMemoryStore();
  mocks.abortSession.mockResolvedValue(true);
  mocks.getReplayParts.mockResolvedValue([{ type: "text", text: "hello" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("active global cooldown routes mapped models to fallback", async () => {
  const now = Date.now();
  mocks.store = createMemoryStore({
    cooldowns: {
      [ORIGINAL]: {
        failedAt: now - 1_000,
        cooldownUntil: now + 60_000,
        reason: "rate-limit",
      },
    },
  });
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });
  const output = { message: { model: modelObject(ORIGINAL) } };

  await router["chat.message"]({ sessionID: "session-1", model: modelObject(ORIGINAL) }, output);

  expect(output.message.model).toEqual(modelObject(FALLBACK));
  expect(ctx.toasts[0]).toEqual({
    title: "Model Fallback",
    message: `Using ${FALLBACK} instead of ${ORIGINAL}`,
    variant: "warning",
    duration: 5000,
  });
});

test("repeated stale UI model only notifies once for the same routed target", async () => {
  const now = Date.now();
  mocks.store = createMemoryStore({
    cooldowns: {
      [ORIGINAL]: {
        failedAt: now - 1_000,
        cooldownUntil: now + 60_000,
        reason: "rate-limit",
      },
    },
  });
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );

  expect(ctx.toasts).toHaveLength(1);
  expect(ctx.toasts[0]).toMatchObject({
    title: "Model Fallback",
    message: `Using ${FALLBACK} instead of ${ORIGINAL}`,
  });
});

test("route notifications follow repeated target changes in one session", async () => {
  const now = Date.now();
  const cooldowns = {
    [ORIGINAL]: {
      failedAt: now - 1_000,
      cooldownUntil: now + 60_000,
      reason: "rate-limit",
    },
  };
  mocks.store = createMemoryStore({ cooldowns });
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );

  delete cooldowns[ORIGINAL];
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(FALLBACK) },
    { message: { model: modelObject(FALLBACK) } },
  );
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(FALLBACK) },
    { message: { model: modelObject(FALLBACK) } },
  );

  cooldowns[ORIGINAL] = {
    failedAt: now + 1_000,
    cooldownUntil: now + 120_000,
    reason: "rate-limit",
  };
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(FALLBACK) },
    { message: { model: modelObject(FALLBACK) } },
  );

  expect(ctx.toasts).toEqual([
    expect.objectContaining({
      title: "Model Fallback",
      message: `Using ${FALLBACK} instead of ${ORIGINAL}`,
    }),
    expect.objectContaining({
      title: "Model Recovered",
      message: `${FALLBACK} -> ${ORIGINAL}`,
    }),
    expect.objectContaining({
      title: "Model Fallback",
      message: `${ORIGINAL} -> ${FALLBACK}`,
    }),
  ]);
});

test("manual fallback selection switches back to original when cooldown is inactive", async () => {
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });
  const output = { message: { model: modelObject(FALLBACK) } };

  await router["chat.message"]({ sessionID: "session-1", model: modelObject(FALLBACK) }, output);

  expect(output.message.model).toEqual(modelObject(ORIGINAL));
  expect(ctx.toasts[0]).toEqual({
    title: "Model Recovered",
    message: `Using ${ORIGINAL} instead of ${FALLBACK}`,
    variant: "info",
    duration: 5000,
  });
});

test("original selection is preserved when cooldown is inactive", async () => {
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });
  const output = { message: { model: modelObject(ORIGINAL) } };

  await router["chat.message"]({ sessionID: "session-1", model: modelObject(ORIGINAL) }, output);

  expect(output.message.model).toEqual(modelObject(ORIGINAL));
});

test("manual switches between mapped originals do not show recovery toasts", async () => {
  const otherOriginal = "openai/gpt-2";
  const otherFallback = "azure/gpt-2";
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: {
      [ORIGINAL]: FALLBACK,
      [otherOriginal]: otherFallback,
    },
  });

  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );
  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(otherOriginal) },
    { message: { model: modelObject(otherOriginal) } },
  );

  expect(ctx.toasts).toHaveLength(0);
});

test("original failure sets global cooldown and replays on fallback", async () => {
  const now = Date.now();
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  const event = router.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { status: 429 },
        model: ORIGINAL,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(150);
  await event;

  expect(ctx.prompts[0].body.model).toEqual(modelObject(FALLBACK));
  expect(mocks.store.getModelCooldown(ORIGINAL).cooldownUntil).toBe(now + 3_600_000);
});

test("provider retry status uses tracked original model when event has no model", async () => {
  const now = Date.now();
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  await router["chat.message"](
    { sessionID: "session-1", model: modelObject(ORIGINAL) },
    { message: { model: modelObject(ORIGINAL) } },
  );
  const event = router.event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: {
          type: "retry",
          attempt: 1,
          message: "The usage limit has been reached",
          next: 1000,
        },
      },
    },
  });
  await vi.advanceTimersByTimeAsync(150);
  await event;

  expect(mocks.abortSession).toHaveBeenCalledWith(ctx.client, "session-1");
  expect(ctx.prompts[0].body.model).toEqual(modelObject(FALLBACK));
  expect(mocks.store.getModelCooldown(ORIGINAL).cooldownUntil).toBe(now + 3_600_000);
});

test("non-retryable mapped provider errors do not trigger fallback", async () => {
  const ctx = createContext();
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  await router.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { status: 403, message: "usage limit exceeded" },
        model: ORIGINAL,
      },
    },
  });

  expect(ctx.prompts).toHaveLength(0);
  expect(mocks.store.getModelCooldown(ORIGINAL)).toBeUndefined();
});

function createContext() {
  const prompts = [];
  const toasts = [];
  const ctx = {
    prompts,
    toasts,
    abortCount: 0,
    directory: "/tmp/project",
    client: {
      session: {
        abort: async () => {
          ctx.abortCount += 1;
        },
        promptAsync: async (request) => {
          prompts.push(request);
        },
      },
      tui: {
        showToast: async (request) => {
          toasts.push(request.body);
        },
      },
    },
  };
  return ctx;
}

function createMemoryStore({ cooldowns = {} } = {}) {
  return {
    getModelCooldown(model) {
      return cooldowns[model];
    },
    setModelCooldown(model, reason, failedAt, cooldownUntil) {
      cooldowns[model] = { reason, failedAt, cooldownUntil };
    },
  };
}

function modelObject(model) {
  const [providerID, modelID] = model.split("/");
  return { providerID, modelID };
}
