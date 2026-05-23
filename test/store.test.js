import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createStateStore } from "../lib/store.js";

test("state store writes global model cooldowns at the top level", () => {
  const dir = mkdtempSync(join(tmpdir(), "mapped-fallback-router-"));
  const storePath = join(dir, "store.json");
  const now = Date.now();

  try {
    const store = createStateStore(storePath);
    store.setModelCooldown("openai/gpt", "rate-limit", now, now + 60_000);
    store.setModelCooldown("openai/other", "quota", now, now + 60_000);

    const written = JSON.parse(readFileSync(storePath, "utf8"));
    expect(written["openai/gpt"].reason).toBe("rate-limit");
    expect(written["openai/other"].reason).toBe("quota");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store prunes expired global model cooldowns", () => {
  const dir = mkdtempSync(join(tmpdir(), "mapped-fallback-router-"));
  const storePath = join(dir, "store.json");
  writeFileSync(
    storePath,
    `${JSON.stringify({
      "openai/gpt": {
        failedAt: 1,
        cooldownUntil: 1,
        reason: "rate-limit",
      },
    })}\n`,
  );

  try {
    const store = createStateStore(storePath);
    expect(store.getModelCooldown("openai/gpt")).toBeUndefined();

    const written = JSON.parse(readFileSync(storePath, "utf8"));
    expect(written["openai/gpt"]).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
