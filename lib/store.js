import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STORE_PATH = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share"),
  "opencode",
  "mapped-fallback-router.json",
);

export function createStateStore(storePath = STORE_PATH) {
  function read() {
    try {
      if (!existsSync(storePath)) return {};
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function write(store) {
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      const tempPath = `${storePath}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`);
      renameSync(tempPath, storePath);
    } catch {
      // Persisted cooldown state is best effort. In-memory fallback still works.
    }
  }

  return {
    getModelCooldown(model) {
      if (!model) return undefined;
      const store = read();
      const record = store[model];
      if (!record) return undefined;
      if (Date.now() < record.cooldownUntil) return record;
      delete store[model];
      write(store);
      return undefined;
    },

    setModelCooldown(model, reason, failedAt, cooldownUntil) {
      const store = read();
      store[model] = { failedAt, cooldownUntil, reason };
      write(store);
    },
  };
}
