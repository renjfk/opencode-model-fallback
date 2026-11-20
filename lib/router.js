import { createActivity } from "./activity.js";
import { isRetryable } from "./errors.js";
import { modelRef, modelRefString } from "./models.js";
import { normalizeOptions } from "./options.js";
import { createStateStore } from "./store.js";

export function createMappedFallbackRouter(ctx, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const fallbackToOriginal = Object.fromEntries(
    Object.entries(options.mappings).map(([original, fallback]) => [fallback, original]),
  );
  const store = createStateStore(ctx.storage);
  const activity = createActivity();
  const retrying = new Set();
  const fallbackAttempts = new Map();
  const activeOriginals = new Map();
  const activeRequested = new Map();
  const activeTargets = new Map();

  function hasMapping(model) {
    return !!model && !!options.mappings[model];
  }

  function mappedOriginal(model) {
    if (hasMapping(model)) return model;
    return fallbackToOriginal[model];
  }

  function shouldRoute(requested) {
    return hasMapping(requested) || !!fallbackToOriginal[requested];
  }

  async function selectedModel(requested) {
    const original = mappedOriginal(requested);
    if (!original) return requested;
    const fallback = options.mappings[original];
    if (!fallback) return requested;
    const cooldown = await store.getModelCooldown(original);
    return cooldown ? fallback : original;
  }

  function notify(title, message) {
    if (!options.notify_on_fallback) return;
    console.warn(`[model-fallback] ${title}: ${message}`);
  }

  function logRouteChange(sessionID, requested, target, original) {
    const previousRequested = activeRequested.get(sessionID);
    const previous = activeTargets.get(sessionID);
    activeRequested.set(sessionID, requested);
    activeTargets.set(sessionID, target);
    if (previous === target) return;
    if (!previous && requested === target) return;
    if (requested === target && previousRequested === previous) return;
    const isFallback = target !== original;
    notify(
      isFallback ? "Model Fallback" : "Model Recovered",
      previous ? `${previous} -> ${target}` : `Using ${target} instead of ${requested}`,
    );
  }

  /**
   * V1 `chat.message` -> V2 session `prompt` hook. Runs when a prompt is
   * submitted, before the model request is built. The context hook's `model`
   * field is readonly and core builds the request from its input anyway, so
   * writing it there never routed anything; switching the session model here
   * is what actually routes the current turn.
   */
  async function prompt(event) {
    const sessionID = event.sessionID;
    if (!sessionID) return;
    // SessionPrompt carries no model; the session's current selection does.
    const session = await ctx.session.get({ sessionID }).catch(() => undefined);
    const requested = modelRefString(session?.model);
    if (!requested || !shouldRoute(requested)) return;
    fallbackAttempts.set(sessionID, 0);
    const original = mappedOriginal(requested);
    const target = await selectedModel(requested);
    if (!target) return;
    if (original) activeOriginals.set(sessionID, original);
    const variant = session?.model?.variant;
    if (target !== requested) await switchSessionModel(sessionID, target, variant).catch(() => {});
    activity.used(target, sessionID, variant);
    logRouteChange(sessionID, requested, target, original);
  }

  async function switchSessionModel(sessionID, model, variant) {
    if (!sessionID) return;
    const ref = modelRef(model, variant);
    if (!ref) return;
    if (ref.variant && ctx.model?.list) {
      const result = await ctx.model.list();
      const models = Array.isArray(result) ? result : (result.data ?? []);
      const target = models.find(
        (item) => item.providerID === ref.providerID && item.id === ref.id,
      );
      if (target && !target.variants?.some((item) => item.id === ref.variant)) delete ref.variant;
    }
    await ctx.session.switchModel({ sessionID, model: ref });
    activity.used(modelRefString(ref), sessionID, ref.variant);
  }

  /**
   * V1 `session.error`/`session.status` handling -> V2 session `retry` hook.
   * A retryable failure on a mapped original sets the global cooldown, switches
   * the session to the fallback, and forces the retry so the next attempt runs
   * on the fallback model. When a cooldown is already active (another session
   * tripped it) the cooldown window is left untouched, but this session is
   * still switched and the retry still forced: without that, a session that
   * stayed on the original would sit out the provider's retry-after (or fail
   * outright for errors only this plugin treats as retryable) while the
   * fallback is ready. Cooldown expiry routes requests back to the original
   * through the `prompt` hook.
   */
  async function retry(event) {
    const sessionID = event.sessionID;
    if (!sessionID || retrying.has(sessionID)) return;
    const requested = modelRefString(event.model);
    if (shouldRoute(requested)) {
      activity.failed(requested, event.error, event.attempt, sessionID, event.model?.variant);
    }
    if (!isRetryable(event.error, options)) return;
    const original = mappedOriginal(requested);
    if (!original) return;
    const attempts = fallbackAttempts.get(sessionID) ?? 0;
    if (hasMapping(requested) && attempts >= options.max_fallback_attempts) {
      event.decision = { retry: false };
      notify(
        "Model Fallback Exhausted",
        `Stopped after ${attempts} fallback switches for ${requested}`,
      );
      return;
    }
    if (requested !== original) {
      notify("Model Fallback Exhausted", `No mapped fallback left for ${original}`);
      return;
    }
    if (!(await store.getModelCooldown(original))) {
      const failedAt = Date.now();
      await store.setModelCooldown(
        original,
        event.error?.type ?? "retry",
        failedAt,
        failedAt + options.cooldown_seconds * 1000,
      );
    }
    retrying.add(sessionID);
    try {
      const fallback = options.mappings[original];
      activeOriginals.set(sessionID, original);
      await switchSessionModel(sessionID, fallback, event.model?.variant);
      fallbackAttempts.set(sessionID, attempts + 1);
      event.decision = { retry: true, delay: options.retry_delay_ms ?? 0 };
      notify("Model Fallback", `${original} -> ${fallback} (${event.error?.type ?? "retry"})`);
    } finally {
      retrying.delete(sessionID);
    }
  }

  /**
   * V1 `event` handler -> V2 `ctx.event.subscribe` background loop.
   */
  async function event(event) {
    if (event?.type === "session.deleted") {
      const id = event?.data?.sessionID;
      if (id) {
        retrying.delete(id);
        fallbackAttempts.delete(id);
        activeOriginals.delete(id);
        activeRequested.delete(id);
        activeTargets.delete(id);
      }
    }
  }

  async function setup() {
    const promptHook = await ctx.session.hook("prompt", (event) => prompt(event));
    const retryHook = await ctx.session.hook("retry", (event) => retry(event));
    const controller = new AbortController();
    const loop = (async () => {
      try {
        // Only session deletions matter here; an unfiltered subscription would
        // receive every streaming delta just to be discarded.
        for await (const e of ctx.event.subscribe({
          signal: controller.signal,
          types: ["session.deleted"],
        })) {
          await event(e);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          console.error("[model-fallback] event subscription failed", error);
      }
    })();
    return async () => {
      controller.abort();
      await loop.catch(() => {});
      await promptHook.dispose();
      await retryHook.dispose();
    };
  }

  return {
    name: "mapped-fallback-router",
    setup,
    prompt,
    retry,
    event,
    status: activity.snapshot,
    subscribe: activity.subscribe,
  };
}
