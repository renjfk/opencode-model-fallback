import { expect, test, vi } from "vitest";

import TuiPlugin from "../tui.js";

test("TUI keeps only the sidebar and fallback configuration command", async () => {
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
      dialog: { clear: vi.fn() },
      slot: vi.fn((slot) => {
        slots.push(slot);
        return vi.fn();
      }),
    },
  };

  const cleanup = await TuiPlugin.setup(context);
  expect(slots).toHaveLength(1);
  expect(slots[0].append).toBe("sidebar.content");
  expect(slots[0].render).toBeTypeOf("function");

  const commands = layer().commands;
  expect(commands).toHaveLength(1);
  expect(commands[0].slash.name).toBe("fallback-config");

  await cleanup();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
