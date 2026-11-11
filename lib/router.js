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
  const retrying = new Set();
  const activeOriginals = new Map();
  const activeRequested = new Map();
  const activeTargets = new Map();
  // Availability routing: a mapped original that is not in OpenCode's enabled model
  // inventory (e.g. its provider has no credentials on this machine) is routed to its
  // fallback even without a failure-driven cooldown, and sessions return to the
  // original once it is available again.
  const AVAILABLE_MODELS_TTL_MS = 30_000;
  let availableModels;
  let availableModelsFetchedAt = 0;
  let availableModelsRequest;

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
    if (cooldown) return fallback;
    if (!(await isModelAvailable(original))) return fallback;
    return original;
  }

  function invalidateAvailableModels() {
    availableModelsFetchedAt = 0;
  }

  async function fetchAvailableModels() {
    if (Date.now() - availableModelsFetchedAt < AVAILABLE_MODELS_TTL_MS) return availableModels;
    if (availableModelsRequest) return availableModelsRequest;
    availableModelsRequest = (async () => {
      try {
        const result = await ctx.model.list();
        // The client returns { location, data }; older hosts may return a bare array.
        const models = Array.isArray(result) ? result : (result?.data ?? []);
        availableModels = new Set(
          models
            .filter((model) => model.enabled !== false)
            .map((model) => `${model.providerID}/${model.modelID}`),
        );
      } catch {
        // An untrusted inventory must never route: treat every model as available
        // until a fresh snapshot arrives.
        availableModels = undefined;
      } finally {
        availableModelsFetchedAt = Date.now();
      }
      return availableModels;
    })();
    try {
      return await availableModelsRequest;
    } finally {
      availableModelsRequest = undefined;
    }
  }

  async function isModelAvailable(model) {
    if (!options.route_unavailable) return true;
    const available = await fetchAvailableModels();
    if (!available) return true;
    return available.has(model);
  }

  async function agentPinnedModel(agentID) {
    if (!agentID || typeof agentID !== "string" || !ctx.agent?.get) return undefined;
    try {
      const agent = await ctx.agent.get({ agentID });
      // The client returns { location, data }; older hosts may return the info directly.
      return modelRefString(agent?.data?.model ?? agent?.model);
    } catch {
      return undefined;
    }
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
    let requested = modelRefString(session?.model);
    if (!requested) {
      // Sessions without an explicit selection (e.g. subagents) run on their
      // agent's pinned model; availability routing applies to that pin too.
      // Only a mapped original pin may be routed away - a deliberately pinned
      // fallback is respected.
      requested = await agentPinnedModel(session?.agent);
      if (!requested || !hasMapping(requested)) return;
    } else if (!shouldRoute(requested)) {
      return;
    }
    const original = mappedOriginal(requested);
    const target = await selectedModel(requested);
    if (!target) return;
    if (original) activeOriginals.set(sessionID, original);
    if (target !== requested) await switchSessionModel(sessionID, target).catch(() => {});
    logRouteChange(sessionID, requested, target, original);
  }

  async function switchSessionModel(sessionID, model) {
    if (!sessionID) return;
    const ref = modelRef(model);
    if (!ref) return;
    await ctx.session.switchModel({ sessionID, model: ref });
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
    if (!isRetryable(event.error, options)) return;
    const requested = modelRefString(event.model);
    const original = mappedOriginal(requested);
    if (!original) return;
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
      await switchSessionModel(sessionID, fallback);
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
    if (event?.type === "provider.updated" || event?.type === "model.updated") {
      invalidateAvailableModels();
      return;
    }
    if (event?.type === "session.deleted") {
      const id = event?.data?.sessionID;
      if (id) {
        retrying.delete(id);
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
        // Only deletions and inventory changes matter here; an unfiltered
        // subscription would receive every streaming delta just to be discarded.
        for await (const e of ctx.event.subscribe({
          signal: controller.signal,
          types: ["session.deleted", "provider.updated", "model.updated"],
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
  };
}
