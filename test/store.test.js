import { expect, test } from "vitest";

import { createStateStore } from "../lib/store.js";

test("state store writes global model cooldowns under a namespaced key", async () => {
  const storage = createMemoryStorage();
  const now = Date.now();

  const store = createStateStore(storage);
  await store.setModelCooldown("openai/gpt", "rate-limit", now, now + 60_000);
  await store.setModelCooldown("openai/other", "quota", now, now + 60_000);

  expect(storage.data.get("cooldown:openai/gpt").reason).toBe("rate-limit");
  expect(storage.data.get("cooldown:openai/other").reason).toBe("quota");
});

test("state store prunes expired global model cooldowns", async () => {
  const storage = createMemoryStorage({
    "cooldown:openai/gpt": { failedAt: 1, cooldownUntil: 1, reason: "rate-limit" },
  });

  const store = createStateStore(storage);

  expect(await store.getModelCooldown("openai/gpt")).toBeUndefined();
  expect(storage.data.has("cooldown:openai/gpt")).toBe(false);
});

test("state store tolerates a missing storage backend", async () => {
  const store = createStateStore({
    async get() {
      throw new Error("unavailable");
    },
    async set() {
      throw new Error("unavailable");
    },
    async remove() {
      throw new Error("unavailable");
    },
  });

  await store.setModelCooldown("openai/gpt", "rate-limit", Date.now(), Date.now() + 60_000);
  expect(await store.getModelCooldown("openai/gpt")).toBeUndefined();
});

function createMemoryStorage(initial = {}) {
  return {
    data: new Map(Object.entries(initial)),
    async get(key) {
      return this.data.get(key);
    },
    async set(key, value) {
      this.data.set(key, value);
    },
    async remove(key) {
      this.data.delete(key);
    },
  };
}
