import { expect, test } from "vitest";

import { isRetryable } from "../lib/errors.js";
import { normalizeOptions } from "../lib/options.js";

test("default retryable error pattern only matches rate limit text", () => {
  const options = normalizeOptions();

  expect(options.retryable_error_patterns).toEqual(["rate.?limit"]);
  expect(isRetryable("rate limit exceeded", options)).toBe(true);
  expect(isRetryable("rate-limit exceeded", options)).toBe(true);
  expect(isRetryable("rate_limit exceeded", options)).toBe(true);
  expect(isRetryable("too many requests", options)).toBe(false);
});
