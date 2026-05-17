const DEFAULT_OPTIONS = {
  mappings: {},
  retry_on_errors: [429],
  retryable_error_patterns: ["rate.?limit"],
  cooldown_seconds: 3600,
  timeout_seconds: 30,
  notify_on_fallback: true,
};

export function normalizeOptions(rawOptions) {
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    mappings: normalizeMappings(rawOptions?.mappings ?? {}),
  };
}

function normalizeMappings(mappings) {
  const normalized = {};
  for (const [from, to] of Object.entries(mappings)) {
    if (!from || typeof to !== "string" || !to.includes("/")) continue;
    normalized[from] = to;
  }
  return normalized;
}
