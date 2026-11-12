const DEFAULT_OPTIONS = {
  mappings: {},
  retry_on_errors: [429],
  retryable_error_patterns: ["rate.?limit"],
  cooldown_seconds: 3600,
  notify_on_fallback: true,
  route_unavailable: true,
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
    // Mapping keys are variant-less: the session's reasoning effort is matched
    // onto the target automatically, or set explicitly in the value's #variant.
    normalized[from.split("#")[0]] = to;
  }
  return normalized;
}
