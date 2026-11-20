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
        current: vi.fn(() => ({ type: "home" })),
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
  expect(slots.find((slot) => slot.append === "sidebar.content")?.render).toBeTypeOf("function");
  expect(slots.find((slot) => slot.append === "home.footer.status")?.render).toBeTypeOf("function");

  const commands = layer().commands;
  expect(commands[0].slash.name).toBe("fallback");
  expect(commands[1].slash.name).toBe("fallback-config");
  await commands[0].run();
  expect(context.ui.router.navigate).toHaveBeenCalledWith({ type: "plugin", name: "fallback" });

  const close = commands.find((command) => command.id === "model-fallback.dashboard.close");
  expect(close.enabled()).toBe(false);
  context.ui.router.current.mockReturnValue({ type: "plugin", name: "fallback" });
  expect(close.enabled()).toBe(true);
  close.run();
  expect(context.ui.router.navigate).toHaveBeenLastCalledWith({ type: "home" });

  await cleanup();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
