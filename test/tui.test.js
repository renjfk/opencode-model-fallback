import { expect, test, vi } from "vitest";

import TuiPlugin from "../tui.js";

test("TUI registers the fallback dashboard and recent-model footer", async () => {
  const routes = new Map();
  const slots = [];
  let layer;
  const unsubscribe = vi.fn();
  const context = {
    options: {
      mappings: {
        "kimi/k3": "go/kimi-k3",
        "go/kimi-k3": "go/deepseek",
      },
    },
    client: {
      rpc: () => ({
        status: vi.fn(async () => ({
          latest: { model: "go/deepseek", variant: "high", at: Date.now() },
          models: {},
        })),
        events: { on: vi.fn(() => unsubscribe) },
      }),
    },
    theme: { text: { base: "base", muted: "muted" } },
    keymap: {
      layer: vi.fn((value) => {
        layer = value;
      }),
    },
    ui: {
      router: {
        register: vi.fn((route) => {
          routes.set(route.name, route);
          return vi.fn();
        }),
        navigate: vi.fn(),
      },
      slot: vi.fn((slot) => {
        slots.push(slot);
        return vi.fn();
      }),
    },
  };

  const cleanup = await TuiPlugin.setup(context);
  const dashboard = routes.get("fallback");
  expect(dashboard).toBeDefined();
  expect(dashboard.render).toBeTypeOf("function");
  expect(slots[0].append).toBe("home.footer.status");
  expect(slots[0].render).toBeTypeOf("function");

  const commands = layer().commands;
  expect(commands[0].slash.name).toBe("fallback");
  await commands[0].run();
  expect(context.ui.router.navigate).toHaveBeenCalledWith({ type: "plugin", name: "fallback" });

  await cleanup();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
