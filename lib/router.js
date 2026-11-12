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

  // Chains are the transitive composition of the one-to-one mappings:
  // { A: B, B: C } routes A through B to C. A cycle truncates at the first
  // repeat, and the global cooldown store keeps a failure from looping.
  function chainFrom(model) {
    const chain = [];
    const visited = new Set();
    let current = model;
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      const next = options.mappings[current];
      if (!next) break;
      current = next;
    }
    return chain;
  }

  // The upstream root of a chain member: walking reverse mappings until a
  // model that is not itself a fallback. Cycles stop at the first repeat.
  function chainRootOf(model) {
    const visited = new Set();
    let root;
    let current = model;
    while (current && !visited.has(current)) {
      visited.add(current);
      root = current;
      current = fallbackToOriginal[current];
    }
    return root && root !== model ? root : undefined;
  }

  async function isRoutable(model) {
    // Chain members may carry an explicit #variant; cooldowns and the
    // inventory are keyed by the base name.
    const name = modelRefString(modelRef(model)) ?? model;
    if (await store.getModelCooldown(name)) return false;
    return await isModelAvailable(name);
  }

  // The first chain member after `model` that can serve the request.
  async function nextInChain(model) {
    for (const candidate of chainFrom(model).slice(1)) {
      if (await isRoutable(candidate)) return candidate;
    }
    return undefined;
  }

  async function selectedModel(sessionID, requested) {
    if (hasMapping(requested)) {
      // A mapping key is the root of its own chain: it advances only when it
      // cannot serve the request itself.
      if (await isRoutable(requested)) {
        // A chain member that is itself a mapping key still recovers toward
        // its upstream root when the session actually arrived from there.
        const root = chainRootOf(requested);
        if (root && (await isRoutable(root)) && (await sessionUsedModel(sessionID, root))) {
          return root;
        }
        return requested;
      }
      return (await nextInChain(requested)) ?? requested;
    }
    // A mapped fallback recovers to its predecessor once that is healthy again.
    const predecessor = fallbackToOriginal[requested];
    if (predecessor && (await isRoutable(predecessor))) return predecessor;
    return requested;
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
        availableModels = new Map(
          models
            .filter((model) => model.enabled !== false)
            .map((model) => [
              // The catalog id is the selectable reference used by sessions,
              // agent pins and mappings; `modelID` is what the provider sends
              // and may differ (a `modelID` config attribute renaming a model).
              `${model.providerID}/${model.id ?? model.modelID}`,
              new Set((model.variants ?? []).map((variant) => variant.id)),
            ]),
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

  // Whether a model lists the given reasoning effort as a variant. An
  // untrustworthy inventory never reports support, so the effort is dropped.
  async function supportsVariant(model, variant) {
    if (!variant || variant === "default") return false;
    const available = await fetchAvailableModels();
    if (!available) return false;
    return available.get(model)?.has(variant) === true;
  }

  async function agentPinnedModel(agentID) {
    if (!agentID || typeof agentID !== "string" || !ctx.agent?.get) return undefined;
    try {
      const agent = await ctx.agent.get({ agentID });
      // The client returns { location, data }; older hosts may return the info directly.
      return agent?.data?.model ?? agent?.model;
    } catch {
      return undefined;
    }
  }

  // The effort the original last ran with, without plugin-side state: the
  // session agent's pinned model when it points at the original, else the
  // most recent assistant message the original produced. Both sources are
  // persisted, so recovery survives plugin restarts.
  async function recoveredEffort(sessionID, agentID, original) {
    const pin = await agentPinnedModel(agentID);
    if (pin && modelRefString(pin) === original && pin.variant && pin.variant !== "default") {
      return pin.variant;
    }
    if (!ctx.session?.context) return undefined;
    try {
      const result = await ctx.session.context({ sessionID });
      const messages = Array.isArray(result) ? result : (result?.data ?? []);
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const model = message?.type === "assistant" ? message.model : undefined;
        if (!model?.providerID || !model?.id) continue;
        if (`${model.providerID}/${model.id}` !== original) continue;
        return model.variant && model.variant !== "default" ? model.variant : undefined;
      }
    } catch {
      // History is best-effort: without it the original recovers at its default.
    }
    return undefined;
  }

  // Whether the session ever ran on the given model - evidence that it
  // arrived at the current chain member from there. Best-effort: compaction
  // may have dropped the evidence.
  async function sessionUsedModel(sessionID, model) {
    if (!ctx.session?.context) return false;
    try {
      const result = await ctx.session.context({ sessionID });
      const messages = Array.isArray(result) ? result : (result?.data ?? []);
      return messages.some(
        (message) =>
          message?.type === "assistant" &&
          message.model?.providerID &&
          `${message.model.providerID}/${message.model.id}` === model,
      );
    } catch {
      return false;
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
    let effort = session?.model?.variant;
    if (!requested) {
      // Sessions without an explicit selection (e.g. subagents) run on their
      // agent's pinned model; availability routing applies to that pin too.
      // Only a mapped original pin may be routed away - a deliberately pinned
      // fallback is respected.
      const pin = await agentPinnedModel(session?.agent);
      requested = modelRefString(pin);
      effort = pin?.variant;
      if (!requested || !hasMapping(requested)) return;
    } else if (!shouldRoute(requested)) {
      return;
    }
    const target = await selectedModel(sessionID, requested);
    if (!target) return;
    // A recovery returns to a healthier model (predecessor or chain root); an
    // advance moves down the chain. The anchor names what the session is
    // recovering to, so notifications report the right direction.
    const isRecovery =
      target === fallbackToOriginal[requested] ||
      (hasMapping(requested) && target === chainRootOf(requested));
    const anchor = isRecovery ? target : mappedOriginal(requested);
    if (anchor) activeOriginals.set(sessionID, anchor);
    if (target !== requested) {
      // On recovery the session may carry no effort (a fallback without support
      // drops it); the target's pin or last recorded response restores it
      // without plugin-side state.
      const recovered =
        isRecovery && !effort
          ? await recoveredEffort(sessionID, session?.agent, target)
          : undefined;
      await switchSessionModel(sessionID, target, recovered ?? effort).catch(() => {});
    }
    logRouteChange(sessionID, requested, target, anchor);
  }

  async function switchSessionModel(sessionID, model, effort) {
    if (!sessionID) return;
    const ref = modelRef(model);
    if (!ref) return;
    // Keep the session's reasoning effort when the target supports it; an
    // explicit #variant in the mapping value always wins. An unsupported or
    // unknown effort falls back to the target's default, as before.
    if (!ref.variant && (await supportsVariant(`${ref.providerID}/${ref.id}`, effort))) {
      ref.variant = effort;
    }
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
    const failed = modelRefString(event.model);
    if (!failed || !shouldRoute(failed)) return;
    // The failed model is the root of its own chain: the next member that can
    // serve the request takes over. Cooldowns skip recently failed members,
    // which also breaks configured cycles.
    const next = hasMapping(failed) ? await nextInChain(failed) : undefined;
    if (!next) {
      notify("Model Fallback Exhausted", `No mapped fallback left for ${failed}`);
      return;
    }
    if (!(await store.getModelCooldown(failed))) {
      const failedAt = Date.now();
      await store.setModelCooldown(
        failed,
        event.error?.type ?? "retry",
        failedAt,
        failedAt + options.cooldown_seconds * 1000,
      );
    }
    retrying.add(sessionID);
    try {
      activeOriginals.set(sessionID, failed);
      await switchSessionModel(sessionID, next, event.model?.variant);
      event.decision = { retry: true, delay: options.retry_delay_ms ?? 0 };
      notify("Model Fallback", `${failed} -> ${next} (${event.error?.type ?? "retry"})`);
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
