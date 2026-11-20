import { describe, expect, test } from "vitest";

import { moveModel, replaceRoute, routeEdges, routeIsCircular } from "../lib/route-editor.js";

const route = ["kimi/k3", "go/kimi-k3", "go/deepseek"];

describe("route editor transformations", () => {
  test("creates linear and circular edges", () => {
    expect(routeEdges(route, false)).toEqual({
      "kimi/k3": "go/kimi-k3",
      "go/kimi-k3": "go/deepseek",
    });
    expect(routeEdges(route, true)["go/deepseek"]).toBe("kimi/k3");
  });

  test("replaces a complete route while preserving independent routes", () => {
    const mappings = {
      ...routeEdges(route, true),
      "openai/gpt": "anthropic/claude",
    };
    const updated = replaceRoute(mappings, route, ["kimi/k3", "go/deepseek"], false);
    expect(updated).toEqual({
      "openai/gpt": "anthropic/claude",
      "kimi/k3": "go/deepseek",
    });
    expect(updated["go/kimi-k3"]).toBeUndefined();
  });

  test("reorders a model by one-based priority", () => {
    expect(moveModel(route, "go/deepseek", 1)).toEqual(["go/deepseek", "kimi/k3", "go/kimi-k3"]);
    expect(moveModel(route, "kimi/k3", 99)).toEqual(["go/kimi-k3", "go/deepseek", "kimi/k3"]);
  });

  test("detects circular routes", () => {
    expect(routeIsCircular(routeEdges(route, true), route)).toBe(true);
    expect(routeIsCircular(routeEdges(route, false), route)).toBe(false);
  });
});
