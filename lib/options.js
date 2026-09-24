const DEFAULT_OPTIONS = {
  mappings: {},
  retry_on_errors: [429],
  retryable_error_patterns: ["rate.?limit"],
  cooldown_seconds: 3600,
  notify_on_fallback: true,
  continue_message: "Continue from where you left off.",
};

export function normalizeOptions(rawOptions) {
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    mappings: normalizeMappings(rawOptions?.mappings ?? {}),
    continue_message: normalizeContinueMessage(rawOptions?.continue_message),
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

function normalizeContinueMessage(message) {
  return typeof message === "string" && message.trim() !== ""
    ? message
    : DEFAULT_OPTIONS.continue_message;
}
