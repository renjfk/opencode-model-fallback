import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin/tui";
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
import { createSignal, For, Show } from "solid-js";
import { readFallbackConfig, validateFallbackSource } from "./lib/config-file.js";
import {
  activatedRoutes as selectActivatedRoutes,
  displayModel,
  errorLabel,
  fallbackRoutes,
  relativeTime,
} from "./lib/tui-state.js";
import { ModelFallback } from "./rpc.js";

function box(children) {
  return jsxDEV("box", { flexDirection: "column", flexShrink: 0, children }, undefined, true);
}

function card(children, color) {
  return jsxDEV(
    "box",
    {
      flexDirection: "column",
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: color,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 0,
      children,
    },
    undefined,
    true,
  );
}

function text(value, color) {
  return jsxDEV(
    "text",
    {
      fg: color,
      wrapMode: "word",
      get children() {
        return typeof value === "function" ? value() : value;
      },
    },
    undefined,
    true,
  );
}

function runEditor(editor, file) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const args = windows
      ? ["/d", "/s", "/c", `${editor} "${file}"`]
      : ["-c", `${editor} "$1"`, "opencode-model-fallback", file];
    const child = spawn(shell, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Editor stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export default Plugin.define({
  id: "model-fallback.tui",
  async setup(context) {
    const [status, setStatus] = createSignal();
    const [loadError, setLoadError] = createSignal();
    const routes = () => fallbackRoutes(status()?.mappings ?? context.options.mappings);
    const activatedRoutes = () => {
      const selected = context.ui.model.current();
      if (!selected) return [];
      const model = `${selected.providerID}/${selected.modelID}`;
      return selectActivatedRoutes(routes(), model);
    };
    const rpc = context.client.rpc(ModelFallback);

    async function refresh() {
      try {
        setStatus(await rpc.status({}));
        setLoadError(undefined);
      } catch {
        setLoadError("Fallback server status is unavailable");
      }
    }

    const unsubscribe = rpc.events.on("updated", (event) => setStatus(event.data));
    await refresh();

    async function configure() {
      let file;
      try {
        file = await readFallbackConfig();
      } catch (error) {
        context.ui.toast.show({
          title: "Fallback configuration unavailable",
          message: error instanceof Error ? error.message : "Configuration file was not found",
          variant: "error",
        });
        return;
      }

      const editor = context.options.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
      let code;
      try {
        await context.renderer.suspend();
        try {
          code = await runEditor(editor, file.path);
        } finally {
          await context.renderer.resume();
        }
      } catch (error) {
        context.ui.toast.show({
          title: "Could not open editor",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        });
        return;
      }
      if (code !== 0) {
        context.ui.toast.show({
          title: "Editor closed without a successful exit",
          message: `${editor} exited with code ${code}`,
          variant: "error",
        });
        return;
      }

      try {
        const updated = await readFallbackConfig();
        const validation = validateFallbackSource(updated.source);
        if (!validation.valid) {
          context.ui.toast.show({
            title: "Fallback configuration has errors",
            message: validation.errors.join("\n"),
            variant: "error",
            duration: 10_000,
          });
          return;
        }
        context.ui.toast.show({
          title: "Fallback configuration is valid",
          message: updated.path,
          variant: "success",
        });
        await refresh();
      } catch (error) {
        context.ui.toast.show({
          title: "Could not validate configuration",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        });
      }
    }

    function modelView(model, position) {
      const state = () => status()?.models?.[model];
      const recent = () => status()?.latest?.model === model;
      const usedLabel = () => {
        if (!state()?.lastUsedAt || recent()) return undefined;
        return `Used: ${relativeTime(state().lastUsedAt)}`;
      };
      return card(
        [
          text(
            () =>
              `PRIORITY ${position}${
                recent() ? ` [Recent] [${relativeTime(status().latest.at)}]` : ""
              }`,
            context.theme.text.muted,
          ),
          text(() => displayModel(model, state()?.variant), context.theme.text.base),
          jsxDEV(Show, {
            get when() {
              return usedLabel();
            },
            children: (label) => text(() => label(), context.theme.text.muted),
          }),
          jsxDEV(Show, {
            get when() {
              return state()?.lastError;
            },
            children: (error) =>
              text(
                () => `${errorLabel(error())} · ${relativeTime(error().at)}`,
                context.theme.text.muted,
              ),
          }),
        ],
        context.theme.text.muted,
      );
    }

    function sidebarView() {
      return box([
        text("Model fallback", context.theme.text.base),
        jsxDEV(Show, {
          get when() {
            return (
              loadError() ??
              (!routes().length
                ? "No mappings configured"
                : activatedRoutes().length
                  ? undefined
                  : "No activated fallback route")
            );
          },
          children: (notice) => text(() => notice(), context.theme.text.muted),
        }),
        jsxDEV(
          For,
          {
            get each() {
              return activatedRoutes();
            },
            children: (route, routeIndex) =>
              jsxDEV(For, {
                each: route,
                children: (model, modelIndex) =>
                  modelView(model, `${routeIndex() + 1}.${modelIndex() + 1}`),
              }),
          },
          undefined,
          true,
        ),
      ]);
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "model-fallback.configure",
          title: "Edit and validate fallback JSON configuration",
          group: "Models",
          palette: true,
          slash: { name: "fallback-config" },
          run: configure,
        },
      ],
    }));

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: sidebarView,
    });

    return () => {
      unsubscribe();
      unregisterSidebar();
    };
  },
});
