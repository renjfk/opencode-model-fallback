function errorRecord(error, attempt) {
  const message =
    typeof error?.message === "string" ? error.message.slice(0, 500) : "Provider request failed";
  return {
    at: Date.now(),
    type: typeof error?.type === "string" ? error.type : "provider.error",
    message,
    status: typeof error?.status === "number" ? error.status : undefined,
    attempt,
  };
}

export function createActivity() {
  const models = new Map();
  let latest;
  let onUpdate;

  function changed() {
    if (onUpdate) void onUpdate(snapshot());
  }

  function used(model, sessionID, variant) {
    if (!model) return;
    const at = Date.now();
    const current = models.get(model) ?? {};
    models.set(model, { ...current, lastUsedAt: at, sessionID, variant });
    latest = { model, sessionID, variant, at };
    changed();
  }

  function failed(model, error, attempt, sessionID, variant) {
    if (!model) return;
    const current = models.get(model) ?? {};
    models.set(model, {
      ...current,
      lastUsedAt: Date.now(),
      sessionID,
      variant,
      lastError: errorRecord(error, attempt),
    });
    latest = { model, sessionID, variant, at: Date.now() };
    changed();
  }

  function snapshot() {
    return JSON.parse(
      JSON.stringify({
        latest,
        models: Object.fromEntries(models),
      }),
    );
  }

  return {
    used,
    failed,
    snapshot,
    subscribe(callback) {
      onUpdate = callback;
      return () => {
        if (onUpdate === callback) onUpdate = undefined;
      };
    },
  };
}
