import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { readFallbackConfig, validateFallbackSource } from "../lib/config-file.js";

const valid = JSON.stringify({
  plugins: [
    {
      package: "@renjfk/opencode-model-fallback",
      options: {
        mappings: {
          "kimi/k3": "go/kimi-k3",
          "go/kimi-k3": "go/deepseek",
          "go/deepseek": "kimi/k3",
        },
        max_fallback_attempts: 5,
        cooldown_seconds: 3600,
        retry_on_errors: [429, 403],
        retryable_error_patterns: ["rate.?limit", "usage.?limit"],
        notify_on_fallback: true,
      },
    },
  ],
});

describe("validateFallbackSource", () => {
  test("accepts a valid circular route and retry settings", () => {
    const result = validateFallbackSource(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.options.mappings["go/deepseek"]).toBe("kimi/k3");
  });

  test("reports invalid mappings and option types together", () => {
    const config = JSON.parse(valid);
    const options = config.plugins[0].options;
    options.mappings = { invalid: "also-invalid", "same/model": "same/model" };
    options.max_fallback_attempts = -1;
    options.retry_on_errors = [99, 700];
    options.retryable_error_patterns = ["["];
    options.notify_on_fallback = "yes";

    const result = validateFallbackSource(JSON.stringify(config));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Invalid source model");
    expect(result.errors.join("\n")).toContain("cannot fall back to itself");
    expect(result.errors.join("\n")).toContain("max_fallback_attempts");
    expect(result.errors.join("\n")).toContain("retry_on_errors");
    expect(result.errors.join("\n")).toContain("retryable error regex");
    expect(result.errors.join("\n")).toContain("notify_on_fallback");
  });

  test("reports malformed JSONC and missing plugin configuration", () => {
    expect(validateFallbackSource("{").errors).toContain("Configuration is not valid JSONC");
    expect(validateFallbackSource("{}").errors).toContain(
      "The model-fallback plugin is not in the global configuration",
    );
  });
});

test("reads the user's global JSONC file", async () => {
  const home = await mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "model-fallback-config-"),
  );
  const directory = path.join(home, ".config", "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "opencode.jsonc"), valid);

  const result = await readFallbackConfig({ home, env: {} });
  expect(result.path).toBe(path.join(directory, "opencode.jsonc"));
  expect(validateFallbackSource(result.source).valid).toBe(true);
});
