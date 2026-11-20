import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createActivity } from "../lib/activity.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

test("tracks the latest mapped model and its most recent error", () => {
  const activity = createActivity();
  const updates = vi.fn();
  activity.subscribe(updates);

  activity.used("kimi/k3", "session-1", "high");
  vi.advanceTimersByTime(5_000);
  activity.failed(
    "kimi/k3",
    { type: "provider.rate-limit", message: "rate limited", status: 429 },
    1,
    "session-1",
    "high",
  );
  vi.advanceTimersByTime(2_000);
  activity.used("opencode-go/kimi-k3", "session-1", "high");

  expect(activity.snapshot()).toEqual({
    latest: {
      model: "opencode-go/kimi-k3",
      sessionID: "session-1",
      variant: "high",
      at: Date.now(),
    },
    models: {
      "kimi/k3": {
        lastUsedAt: Date.now() - 2_000,
        sessionID: "session-1",
        variant: "high",
        lastError: {
          at: Date.now() - 2_000,
          type: "provider.rate-limit",
          message: "rate limited",
          status: 429,
          attempt: 1,
        },
      },
      "opencode-go/kimi-k3": {
        lastUsedAt: Date.now(),
        sessionID: "session-1",
        variant: "high",
      },
    },
  });
  expect(updates).toHaveBeenCalledTimes(3);
});

test("caps provider error messages and tolerates missing fields", () => {
  const activity = createActivity();
  activity.failed("kimi/k3", { message: "x".repeat(600) });

  const error = activity.snapshot().models["kimi/k3"].lastError;
  expect(error.message).toHaveLength(500);
  expect(error.type).toBe("provider.error");
  expect(error.status).toBeUndefined();
});
