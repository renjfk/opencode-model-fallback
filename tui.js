import { Plugin } from "@opencode/plugin/tui";
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
import { createSignal, For } from "solid-js";
import { displayModel, errorLabel, fallbackRoutes, relativeTime } from "./lib/tui-state.js";
import { ModelFallback } from "./rpc.js";

function box(children) {
  return jsxDEV("box", { flexDirection: "column", children }, undefined, true);
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

export default Plugin.define({
  id: "model-fallback.tui",
  async setup(context) {
    const [status, setStatus] = createSignal();
    const [loadError, setLoadError] = createSignal();
    const routes = fallbackRoutes(context.options.mappings);
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

    function recentLabel() {
      const latest = status()?.latest;
      if (!latest) return "Recent: no mapped model used yet";
      return `Recent: ${displayModel(latest.model, latest.variant)} · ${relativeTime(latest.at)}`;
    }

    function modelView(model, position) {
      const state = () => status()?.models?.[model];
      return box([
        text(
          () => `${position}. ${displayModel(model, state()?.variant)}`,
          context.theme.text.base,
        ),
        text(
          () =>
            `   Used: ${state()?.lastUsedAt ? relativeTime(state().lastUsedAt) : "never"}${
              state()?.sessionID ? ` · ${state().sessionID}` : ""
            }`,
          context.theme.text.muted,
        ),
        text(
          () =>
            `   Error: ${errorLabel(state()?.lastError)}${
              state()?.lastError?.at ? ` · ${relativeTime(state().lastError.at)}` : ""
            }`,
          context.theme.text.muted,
        ),
      ]);
    }

    function dashboard() {
      return box([
        text("Model fallback", context.theme.text.base),
        text(recentLabel, context.theme.text.base),
        text(
          () =>
            loadError() ??
            (routes.length ? "Mappings in priority order" : "No mappings configured"),
          context.theme.text.muted,
        ),
        jsxDEV(
          For,
          {
            each: routes,
            children: (route, routeIndex) =>
              box([
                text(`Route ${routeIndex() + 1}: ${route.join(" → ")}`, context.theme.text.base),
                jsxDEV(For, {
                  each: route,
                  children: (model, modelIndex) =>
                    modelView(model, `${routeIndex() + 1}.${modelIndex() + 1}`),
                }),
              ]),
          },
          undefined,
          true,
        ),
        text("/fallback to reopen · errors are held in server memory", context.theme.text.muted),
      ]);
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "model-fallback.dashboard",
          title: "Show model fallback status",
          group: "Models",
          palette: true,
          slash: { name: "fallback", aliases: ["model-fallback"] },
          run: async () => {
            await refresh();
            context.ui.router.navigate({ type: "plugin", name: "fallback" });
          },
        },
      ],
    }));

    const unregisterRoute = context.ui.router.register({
      name: "fallback",
      render: dashboard,
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () =>
        text(
          () =>
            status()?.latest
              ? `Fallback · ${displayModel(status().latest.model, status().latest.variant)}`
              : "Fallback ready",
          context.theme.text.base,
        ),
    });

    return () => {
      unsubscribe();
      unregisterRoute();
      unregisterFooter();
    };
  },
});
