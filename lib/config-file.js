import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";

async function configPath(env, home) {
  const directory = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(directory, name);
    try {
      return { path: candidate, source: await readFile(candidate, "utf8") };
    } catch {}
  }
  throw new Error("Global opencode.jsonc or opencode.json was not found");
}

function pluginIndex(config) {
  const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
  return plugins.findIndex((plugin) => {
    const name = typeof plugin === "string" ? plugin : plugin?.package;
    return typeof name === "string" && name.includes("opencode-model-fallback");
  });
}

export async function readFallbackConfig(options = {}) {
  return configPath(options.env ?? process.env, options.home ?? os.homedir());
}

export function validateFallbackSource(source) {
  const errors = [];
  const parseErrors = [];
  const config = parse(source, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length) errors.push("Configuration is not valid JSONC");
  const index = pluginIndex(config);
  if (index < 0) errors.push("The model-fallback plugin is not in the global configuration");
  const options = index >= 0 ? config.plugins[index]?.options : undefined;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    errors.push("Fallback plugin options must be an object");
  }

  const mappings = options?.mappings;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    errors.push("options.mappings must be an object");
  } else {
    const entries = Object.entries(mappings);
    if (!entries.length) errors.push("Add at least one fallback mapping");
    for (const [from, to] of entries) {
      if (!from.includes("/") || from.startsWith("/") || from.endsWith("/")) {
        errors.push(`Invalid source model: ${from}`);
      }
      if (typeof to !== "string" || !to.includes("/") || to.startsWith("/") || to.endsWith("/")) {
        errors.push(`Invalid fallback for ${from}`);
      }
      if (from === to) errors.push(`A model cannot fall back to itself: ${from}`);
    }
  }

  if (options?.max_fallback_attempts !== undefined) {
    const value = options.max_fallback_attempts;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      errors.push("max_fallback_attempts must be an integer from 0 to 100");
    }
  }
  if (options?.cooldown_seconds !== undefined) {
    const value = options.cooldown_seconds;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push("cooldown_seconds must be a non-negative number");
    }
  }
  if (options?.retry_on_errors !== undefined) {
    const value = options.retry_on_errors;
    if (
      !Array.isArray(value) ||
      value.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
    ) {
      errors.push("retry_on_errors must contain HTTP status codes from 100 to 599");
    }
  }
  if (options?.retryable_error_patterns !== undefined) {
    const patterns = options.retryable_error_patterns;
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
      errors.push("retryable_error_patterns must contain strings");
    } else {
      for (const pattern of patterns) {
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(`Invalid retryable error regex: ${pattern}`);
        }
      }
    }
  }
  if (
    options?.notify_on_fallback !== undefined &&
    typeof options.notify_on_fallback !== "boolean"
  ) {
    errors.push("notify_on_fallback must be true or false");
  }

  return { valid: errors.length === 0, errors, options };
}
