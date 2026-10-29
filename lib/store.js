const KEY_PREFIX = "cooldown:";

/**
 * Durable cooldown store backed by the V2 plugin storage domain
 * (`ctx.storage`), which is already namespaced per plugin id.
 */
export function createStateStore(storage) {
  async function read(model) {
    try {
      const record = await storage.get(KEY_PREFIX + model);
      if (!record || typeof record !== "object") return undefined;
      return record;
    } catch {
      return undefined;
    }
  }

  async function remove(model) {
    try {
      await storage.remove(KEY_PREFIX + model);
    } catch {
      // Persisted cooldown state is best effort. In-memory fallback still works.
    }
  }

  return {
    async getModelCooldown(model) {
      if (!model) return undefined;
      const record = await read(model);
      if (!record) return undefined;
      if (Date.now() < record.cooldownUntil) return record;
      await remove(model);
      return undefined;
    },

    async setModelCooldown(model, reason, failedAt, cooldownUntil) {
      try {
        await storage.set(KEY_PREFIX + model, { failedAt, cooldownUntil, reason });
      } catch {
        // Persisted cooldown state is best effort. In-memory fallback still works.
      }
    },
  };
}
