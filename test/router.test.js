import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createMappedFallbackRouter } from "../lib/router.js";

const ORIGINAL = "openai/gpt";
const FALLBACK = "azure/gpt";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("active global cooldown routes mapped models to fallback", async () => {
  const now = Date.now();
  const ctx = createContext(
    {
      [cooldownKey(ORIGINAL)]: cooldown(now - 1_000, now + 60_000),
    },
    modelRef(ORIGINAL),
  );
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: "session-1" });
  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(FALLBACK),
  });
  expect(ctx.warnings()).toEqual([
    { title: "Model Fallback", message: `Using ${FALLBACK} instead of ${ORIGINAL}` },
  ]);
});

test("repeated prompts only notify once for the same routed target", async () => {
  const now = Date.now();
  const ctx = createContext(
    {
      [cooldownKey(ORIGINAL)]: cooldown(now - 1_000, now + 60_000),
    },
    modelRef(ORIGINAL),
  );
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));
  await router.prompt(promptEvent("session-1"));

  expect(ctx.warnings()).toHaveLength(1);
  expect(ctx.warnings()[0]).toMatchObject({
    title: "Model Fallback",
    message: `Using ${FALLBACK} instead of ${ORIGINAL}`,
  });
});

test("route notifications follow repeated target changes in one session", async () => {
  const now = Date.now();
  const ctx = createContext(
    {
      [cooldownKey(ORIGINAL)]: cooldown(now - 1_000, now + 60_000),
    },
    modelRef(ORIGINAL),
  );
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));
  await router.prompt(promptEvent("session-1"));

  await ctx.storage.remove(cooldownKey(ORIGINAL));
  await router.prompt(promptEvent("session-1"));
  await router.prompt(promptEvent("session-1"));

  await ctx.storage.set(cooldownKey(ORIGINAL), cooldown(now + 1_000, now + 120_000));
  await router.prompt(promptEvent("session-1"));

  expect(ctx.warnings()).toEqual([
    { title: "Model Fallback", message: `Using ${FALLBACK} instead of ${ORIGINAL}` },
    { title: "Model Recovered", message: `${FALLBACK} -> ${ORIGINAL}` },
    { title: "Model Fallback", message: `${ORIGINAL} -> ${FALLBACK}` },
  ]);
});

test("manual fallback selection switches back to original when cooldown is inactive", async () => {
  const ctx = createContext({}, modelRef(FALLBACK));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(ORIGINAL),
  });
  expect(ctx.warnings()[0]).toEqual({
    title: "Model Recovered",
    message: `Using ${ORIGINAL} instead of ${FALLBACK}`,
  });
});

test("original selection is preserved when cooldown is inactive", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).not.toHaveBeenCalled();
});

test("manual switches between mapped originals do not show recovery toasts", async () => {
  const otherOriginal = "openai/gpt-2";
  const otherFallback = "azure/gpt-2";
  const ctx = createContext({}, modelRef(ORIGINAL));
  const router = createMappedFallbackRouter(ctx, {
    mappings: {
      [ORIGINAL]: FALLBACK,
      [otherOriginal]: otherFallback,
    },
  });

  await router.prompt(promptEvent("session-1"));
  ctx.sessionModel = modelRef(otherOriginal);
  await router.prompt(promptEvent("session-1"));

  expect(ctx.warnings()).toHaveLength(0);
});

test("original failure sets global cooldown, switches model and forces retry", async () => {
  const now = Date.now();
  const ctx = createContext({}, modelRef(ORIGINAL));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  const event = retryEvent(ORIGINAL, { status: 429, type: "rate-limit", message: "rate limit" });
  await router.retry(event);

  expect(event.decision).toEqual({ retry: true, delay: 0 });
  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(FALLBACK),
  });
  expect(await ctx.storage.get(cooldownKey(ORIGINAL))).toMatchObject({
    cooldownUntil: now + 3_600_000,
  });
});

test("retryable failure with an active cooldown still switches and forces retry without resetting it", async () => {
  const now = Date.now();
  const existing = cooldown(now - 30_000, now + 60_000);
  const ctx = createContext(
    {
      [cooldownKey(ORIGINAL)]: existing,
    },
    modelRef(ORIGINAL),
  );
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  const event = retryEvent(ORIGINAL, { status: 429, type: "rate-limit", message: "rate limit" });
  await router.retry(event);

  expect(event.decision).toEqual({ retry: true, delay: 0 });
  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(FALLBACK),
  });
  // The cooldown another session set is kept exactly as it was.
  expect(await ctx.storage.get(cooldownKey(ORIGINAL))).toEqual(existing);
});

test("a session on the fallback that fails again does not re-switch or reset the cooldown", async () => {
  const now = Date.now();
  const existing = cooldown(now - 30_000, now + 60_000);
  const ctx = createContext(
    {
      [cooldownKey(ORIGINAL)]: existing,
    },
    modelRef(FALLBACK),
  );
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  const event = retryEvent(FALLBACK, { status: 429, type: "rate-limit", message: "rate limit" });
  await router.retry(event);

  expect(event.decision).toEqual({ retry: false });
  expect(ctx.session.switchModel).not.toHaveBeenCalled();
  expect(await ctx.storage.get(cooldownKey(ORIGINAL))).toEqual(existing);
});

test("fallback failure reports an exhausted fallback without changing the decision", async () => {
  const ctx = createContext({}, modelRef(FALLBACK));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  const event = retryEvent(FALLBACK, { status: 429, type: "rate-limit", message: "rate limit" });
  await router.retry(event);

  expect(event.decision).toEqual({ retry: false });
  expect(ctx.session.switchModel).not.toHaveBeenCalled();
  expect(ctx.warnings()).toEqual([
    { title: "Model Fallback Exhausted", message: `No mapped fallback left for ${ORIGINAL}` },
  ]);
});

test("non-retryable mapped provider errors do not trigger fallback", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    notify_on_fallback: false,
  });

  const event = retryEvent(ORIGINAL, {
    status: 403,
    type: "provider-error",
    message: "usage limit exceeded",
  });
  await router.retry(event);

  expect(event.decision).toEqual({ retry: false });
  expect(await ctx.storage.get(cooldownKey(ORIGINAL))).toBeUndefined();
});

test("setup registers hooks, subscribes to deletions only and cleans up", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  const cleanup = await router.setup();

  expect(ctx.hooks.prompt).toHaveLength(1);
  expect(ctx.hooks.retry).toHaveLength(1);
  expect(ctx.subscribeCalls).toBe(1);
  expect(ctx.subscribeTypes).toEqual(["session.deleted", "provider.updated", "model.updated"]);

  await ctx.pushEvent({ type: "session.deleted", data: { sessionID: "session-1" } });
  await cleanup();

  expect(ctx.disposed).toEqual(["prompt", "retry"]);
});

test("unavailable original routes to the fallback without a cooldown", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL), { availableModels: [FALLBACK] });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(FALLBACK),
  });
  expect(ctx.warnings()).toEqual([
    { title: "Model Fallback", message: `Using ${FALLBACK} instead of ${ORIGINAL}` },
  ]);
});

test("session stays on the fallback while the original is unavailable", async () => {
  const ctx = createContext({}, modelRef(FALLBACK), { availableModels: [FALLBACK] });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).not.toHaveBeenCalled();
  expect(ctx.warnings()).toEqual([]);
});

test("session returns to the original once it is available again", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL), { availableModels: [FALLBACK] });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));
  ctx.availableModels = [ORIGINAL, FALLBACK];
  ctx.sessionModel = modelRef(FALLBACK);
  vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).toHaveBeenLastCalledWith({
    sessionID: "session-1",
    model: modelRef(ORIGINAL),
  });
  expect(ctx.warnings()).toEqual([
    { title: "Model Fallback", message: `Using ${FALLBACK} instead of ${ORIGINAL}` },
    { title: "Model Recovered", message: `${FALLBACK} -> ${ORIGINAL}` },
  ]);
});

test("provider updates invalidate the availability snapshot", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL), { availableModels: [FALLBACK] });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });
  const cleanup = await router.setup();

  await router.prompt(promptEvent("session-1"));
  ctx.availableModels = [ORIGINAL, FALLBACK];
  ctx.sessionModel = modelRef(FALLBACK);
  await ctx.pushEvent({ type: "provider.updated", data: {} });
  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).toHaveBeenLastCalledWith({
    sessionID: "session-1",
    model: modelRef(ORIGINAL),
  });
  await cleanup();
});

test("unavailable agent pin routes to the mapped fallback", async () => {
  const ctx = createContext({}, null, {
    availableModels: [FALLBACK],
    agent: { id: "build", model: modelRef(ORIGINAL) },
  });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.agent.get).toHaveBeenCalledWith({ agentID: "build" });
  expect(ctx.session.switchModel).toHaveBeenCalledWith({
    sessionID: "session-1",
    model: modelRef(FALLBACK),
  });
});

test("available agent pin is left untouched", async () => {
  const ctx = createContext({}, null, {
    agent: { id: "build", model: modelRef(ORIGINAL) },
  });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).not.toHaveBeenCalled();
});

test("pinned fallback models are not rerouted to their original", async () => {
  const ctx = createContext({}, null, {
    agent: { id: "build", model: modelRef(FALLBACK) },
  });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).not.toHaveBeenCalled();
});

test("route_unavailable: false keeps cooldown-only routing", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL), { availableModels: [FALLBACK] });
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
    route_unavailable: false,
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.model.list).not.toHaveBeenCalled();
  expect(ctx.session.switchModel).not.toHaveBeenCalled();
});

test("an untrustworthy model inventory never routes", async () => {
  const ctx = createContext({}, modelRef(ORIGINAL));
  ctx.model.list.mockRejectedValue(new Error("inventory unavailable"));
  const router = createMappedFallbackRouter(ctx, {
    mappings: { [ORIGINAL]: FALLBACK },
  });

  await router.prompt(promptEvent("session-1"));

  expect(ctx.session.switchModel).not.toHaveBeenCalled();
});

function promptEvent(sessionID) {
  return { sessionID, messageID: "msg-1", prompt: {}, delivery: "user" };
}

function retryEvent(model, error) {
  return {
    sessionID: "session-1",
    agent: "build",
    model: modelRef(model),
    error,
    attempt: 1,
    decision: { retry: false },
  };
}

function cooldown(failedAt, cooldownUntil, reason = "rate-limit") {
  return { failedAt, cooldownUntil, reason };
}

function cooldownKey(model) {
  return `cooldown:${model}`;
}

function modelRef(model) {
  const [providerID, id] = model.split("/");
  return { providerID, id };
}

function createContext(initial = {}, sessionModel = modelRef(ORIGINAL), overrides = {}) {
  const data = new Map(Object.entries(initial));
  const warningLines = [];
  const hooks = { prompt: [], retry: [] };
  const disposed = [];
  const queue = [];
  const resolvers = [];
  const ctx = {
    hooks,
    disposed,
    subscribeCalls: 0,
    subscribeTypes: undefined,
    sessionModel,
    agentID: overrides.agentID ?? "build",
    availableModels: overrides.availableModels ?? [
      ORIGINAL,
      FALLBACK,
      "openai/gpt-2",
      "azure/gpt-2",
    ],
    model: {
      list: vi.fn(async () => ({
        data: ctx.availableModels.map((name) => {
          const [providerID, modelID] = name.split("/");
          return { providerID, modelID, enabled: true };
        }),
      })),
    },
    agent: {
      get: vi.fn(async ({ agentID }) => overrides.agent ?? { id: agentID }),
    },
    storage: {
      async get(key) {
        return data.get(key);
      },
      async set(key, value) {
        data.set(key, value);
      },
      async remove(key) {
        data.delete(key);
      },
    },
    session: {
      get: vi.fn(async ({ sessionID }) => ({
        id: sessionID,
        model: ctx.sessionModel,
        agent: ctx.agentID,
      })),
      switchModel: vi.fn(async () => {}),
      hook: vi.fn(async (name, callback) => {
        hooks[name].push(callback);
        return {
          async dispose() {
            disposed.push(name);
          },
        };
      }),
    },
    event: {
      subscribe(options) {
        ctx.subscribeCalls += 1;
        ctx.subscribeTypes = options?.types;
        const signal = options?.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (queue.length) {
                yield queue.shift();
                continue;
              }
              const value = await new Promise((resolve) => {
                resolvers.push(resolve);
                signal?.addEventListener("abort", () => resolve(undefined), { once: true });
              });
              if (value === undefined) return;
              yield value;
            }
          },
        };
      },
    },
    pushEvent(event) {
      if (resolvers.length) resolvers.shift()(event);
      else queue.push(event);
      return Promise.resolve();
    },
    warnings() {
      return warningLines.map((line) => {
        const match = /^\[model-fallback\] (.*?): (.*)$/.exec(line);
        return match ? { title: match[1], message: match[2] } : { title: "", message: line };
      });
    },
  };
  console.warn.mockImplementation((...args) => {
    warningLines.push(args.join(" "));
  });
  return ctx;
}
