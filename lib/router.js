import { isRetryable, extractErrorName } from "./errors.js";
import { modelObject, modelString } from "./models.js";
import { normalizeOptions } from "./options.js";
import { abortSession, getReplayParts } from "./session.js";
import { createStateStore } from "./store.js";

const POST_ABORT_DELAY_MS = 150;

export function createMappedFallbackRouter(ctx, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const fallbackToOriginal = Object.fromEntries(
    Object.entries(options.mappings).map(([original, fallback]) => [fallback, original]),
  );
  const store = createStateStore();
  const retrying = new Set();
  const selfAbortAt = new Map();
  const activeOriginals = new Map();
  const activeRequested = new Map();
  const activeTargets = new Map();
  let agentConfigs;

  function hasMapping(model) {
    return !!model && !!options.mappings[model];
  }

  function mappedOriginal(model) {
    if (hasMapping(model)) return model;
    return fallbackToOriginal[model];
  }

  function modelFromAgent(agent) {
    const agentConfig = agent && agentConfigs?.[agent];
    return typeof agentConfig === "object" && agentConfig ? agentConfig.model : undefined;
  }

  function selectedModel(requested) {
    const original = mappedOriginal(requested);
    if (!original) return requested;
    const fallback = options.mappings[original];
    if (!fallback) return requested;
    const cooldown = store.getModelCooldown(original);
    return cooldown ? fallback : original;
  }

  function shouldRoute(requested) {
    return hasMapping(requested) || !!fallbackToOriginal[requested];
  }

  function resolveErrorModels(model, agent) {
    const failed = model ?? modelFromAgent(agent);
    const original = mappedOriginal(failed);
    return { failed, original };
  }

  function shouldFallbackFromError(failed, original) {
    if (!original) return false;
    if (failed !== original) return false;
    const cooldown = store.getModelCooldown(original);
    return !cooldown;
  }

  async function abortCurrentSession(sessionID) {
    const aborted = await abortSession(ctx.client, sessionID);
    if (aborted) selfAbortAt.set(sessionID, Date.now());
  }

  async function retryWithFallback(sessionID, original, agent, reason) {
    const fallback = options.mappings[original];
    const target = fallback ? modelObject(fallback) : undefined;
    if (!target) return;
    const failedAt = Date.now();
    const cooldownUntil = failedAt + options.cooldown_seconds * 1000;
    store.setModelCooldown(original, reason, failedAt, cooldownUntil);
    const parts = await getReplayParts(ctx.client, ctx.directory, sessionID);
    if (parts.length === 0) return;
    try {
      await new Promise((resolve) => setTimeout(resolve, POST_ABORT_DELAY_MS));
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: { ...(agent ? { agent } : {}), model: target, parts },
        query: { directory: ctx.directory },
      });
      await toast("Model Fallback", `${original} -> ${fallback} (${reason})`, "warning");
    } catch {}
  }

  async function toast(title, message, variant) {
    if (!options.notify_on_fallback) return;
    await ctx.client.tui
      .showToast({ body: { title, message, variant, duration: 5000 } })
      .catch(() => {});
  }

  async function toastRouteChange(sessionID, requested, target, original) {
    const previousRequested = activeRequested.get(sessionID);
    const previous = activeTargets.get(sessionID);
    activeRequested.set(sessionID, requested);
    activeTargets.set(sessionID, target);
    if (previous === target) return;
    if (!previous && requested === target) return;
    if (requested === target && previousRequested === previous) return;
    const isFallback = target !== original;
    await toast(
      isFallback ? "Model Fallback" : "Model Recovered",
      previous ? `${previous} -> ${target}` : `Using ${target} instead of ${requested}`,
      isFallback ? "warning" : "info",
    );
  }

  async function handleError(sessionID, error, model, agent, source) {
    if (!sessionID || retrying.has(sessionID)) return;
    const name = extractErrorName(error);
    const selfAbort = selfAbortAt.get(sessionID);
    if (name === "MessageAbortedError" && selfAbort && Date.now() - selfAbort < 2000) return;
    const { failed, original } = resolveErrorModels(model, agent);
    if (!original) return;
    const retryable = isRetryable(error, options);
    if (!retryable) return;
    if (failed !== original) {
      await toast("Model Fallback Exhausted", `No mapped fallback left for ${original}`, "error");
      return;
    }
    if (!shouldFallbackFromError(failed, original)) return;
    retrying.add(sessionID);
    try {
      await retryWithFallback(sessionID, original, agent, source);
    } finally {
      retrying.delete(sessionID);
    }
  }

  async function handleProviderRetryStatus(props) {
    const sessionID = props?.sessionID;
    const status = props?.status;
    if (!sessionID || !status || retrying.has(sessionID)) return;
    const type = String(status.type ?? "").toLowerCase();
    if (type !== "retry") return;
    const agent = props?.agent;
    const model =
      props?.model ??
      (typeof props?.providerID === "string" && typeof props?.modelID === "string"
        ? `${props.providerID}/${props.modelID}`
        : (activeOriginals.get(sessionID) ?? modelFromAgent(agent)));
    const { failed, original } = resolveErrorModels(model, agent);
    if (!original) return;
    if (failed !== original) {
      await toast("Model Fallback Exhausted", `No mapped fallback left for ${original}`, "error");
      return;
    }
    if (!shouldFallbackFromError(failed, original)) return;
    retrying.add(sessionID);
    try {
      await abortCurrentSession(sessionID);
      await retryWithFallback(sessionID, original, agent, "session.status");
    } finally {
      retrying.delete(sessionID);
    }
  }

  return {
    name: "mapped-fallback-router",

    config: (config) => {
      const agentValue = config.agent;
      agentConfigs =
        agentValue && typeof agentValue === "object" && !Array.isArray(agentValue)
          ? agentValue
          : undefined;
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID;
      const requested = modelString(input.model) ?? modelFromAgent(input.agent);
      if (!sessionID || !requested) return;
      if (!shouldRoute(requested)) return;
      const target = selectedModel(requested);
      if (!target) return;
      const original = mappedOriginal(requested);
      if (original) activeOriginals.set(sessionID, original);
      const model = modelObject(target);
      if (model && output.message) output.message.model = model;
      await toastRouteChange(sessionID, requested, target, original);
    },

    event: async ({ event }) => {
      const props = event.properties;
      if (event.type === "session.deleted") {
        const id = props?.info?.id;
        if (id) {
          retrying.delete(id);
          activeOriginals.delete(id);
          activeRequested.delete(id);
          activeTargets.delete(id);
        }
        return;
      }
      if (event.type === "session.status") {
        await handleProviderRetryStatus(props);
        return;
      }
      if (event.type === "session.error") {
        await handleError(
          props?.sessionID,
          props?.error,
          props?.model,
          props?.agent,
          "session.error",
        );
        return;
      }
      if (event.type === "message.updated") {
        const info = props?.info;
        if (info?.role !== "assistant") return;
        if (!info?.error) return;
        const sessionID = info?.sessionID;
        const model =
          info?.model ??
          (typeof info?.providerID === "string" && typeof info?.modelID === "string"
            ? `${info.providerID}/${info.modelID}`
            : undefined);
        await handleError(sessionID, info.error, model, info?.agent, "message.updated");
      }
    },
  };
}
