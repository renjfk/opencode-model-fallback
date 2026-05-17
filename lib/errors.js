export function isRetryable(error, options) {
  const status = extractStatus(error);
  if (status && options.retry_on_errors.includes(status)) return true;
  const text = errorText(error).toLowerCase();
  return options.retryable_error_patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return text.includes(pattern.toLowerCase());
    }
  });
}

function extractStatus(error) {
  if (!error || typeof error !== "object") return undefined;
  const value = error.statusCode ?? error.status ?? error.code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function extractErrorName(error) {
  if (!error || typeof error !== "object") return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name} ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
