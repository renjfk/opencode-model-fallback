import { describe, expect, test } from "vitest";

import { displayModel, errorLabel, fallbackRoutes, relativeTime } from "../lib/tui-state.js";

describe("fallbackRoutes", () => {
  test("flattens chained mappings in priority order", () => {
    expect(
      fallbackRoutes({
        "kimi/k3.1-pro": "go/kimi-k3.1-pro",
        "go/kimi-k3.1-pro": "go/deepseek-v4.1-flash",
      }),
    ).toEqual([["kimi/k3.1-pro", "go/kimi-k3.1-pro", "go/deepseek-v4.1-flash"]]);
  });

  test("keeps independent routes and handles cycles", () => {
    expect(
      fallbackRoutes({
        "a/one": "a/two",
        "b/one": "b/two",
        "a/two": "a/one",
      }),
    ).toEqual([
      ["b/one", "b/two"],
      ["a/one", "a/two"],
    ]);
  });

  test("ignores invalid mapping values", () => {
    expect(fallbackRoutes({ "a/one": undefined })).toEqual([]);
    expect(fallbackRoutes(undefined)).toEqual([]);
  });
});

test("formats model variants and recent errors for the TUI", () => {
  expect(displayModel("kimi/k3", "high")).toBe("kimi/k3#high");
  expect(displayModel("kimi/k3", "default")).toBe("kimi/k3");
  expect(errorLabel({ type: "provider.rate-limit", status: 429, message: "slow down" })).toBe(
    "provider.rate-limit 429: slow down",
  );
  expect(relativeTime(Date.now() - 65_000)).toBe("1m ago");
});
