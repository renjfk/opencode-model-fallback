import { Plugin } from "@opencode/plugin/tui";
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
import { createSignal, For } from "solid-js";
import { updateFallbackOptions } from "./lib/config-file.js";
import { displayModel, errorLabel, fallbackRoutes, relativeTime } from "./lib/tui-state.js";
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
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
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

export default Plugin.define({
  id: "model-fallback.tui",
  async setup(context) {
    const [status, setStatus] = createSignal();
    const [loadError, setLoadError] = createSignal();
    const [configuring, setConfiguring] = createSignal(false);
    const routes = () => fallbackRoutes(status()?.mappings ?? context.options.mappings);
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

    async function modelOptions(exclude) {
      const location = context.location ?? context.data.location.default();
      const result = await context.data.location.model.list(location);
      const models = Array.isArray(result) ? result : (result?.data ?? []);
      return models
        .filter((model) => model.enabled !== false && model.type === "chat")
        .map((model) => `${model.providerID}/${model.id}`)
        .filter((model) => model !== exclude)
        .sort()
        .map((model) => ({ title: model, value: model }));
    }

    async function chooseModel(title, exclude) {
      const options = await modelOptions(exclude);
      if (!options.length) {
        context.ui.toast.show({ message: "No available models found", variant: "error" });
        return undefined;
      }
      return context.ui.dialog.select({
        title,
        options,
        search: (query, items) =>
          items.filter((item) => item.value.toLowerCase().includes(query.toLowerCase())),
      });
    }

    async function saveOptions(patch) {
      try {
        const file = await updateFallbackOptions(patch);
        context.ui.toast.show({
          title: "Fallback configuration saved",
          message: file,
          variant: "success",
        });
      } catch (error) {
        context.ui.toast.show({
          title: "Could not save fallback configuration",
          message: error instanceof Error ? error.message : "Configuration update failed",
          variant: "error",
        });
      }
    }

    async function configureDialog() {
      const mappings = { ...(status()?.mappings ?? context.options.mappings) };
      const route = fallbackRoutes(mappings)[0] ?? [];
      const circular = route.length > 1 && mappings[route.at(-1)] === route[0];
      const action = await context.ui.dialog.select({
        title: "Fallback configuration",
        options: [
          { title: "Add mapping", value: "add", description: "Select a source and fallback model" },
          {
            title: "Edit mapping",
            value: "edit",
            description: "Change a mapping's fallback model",
            disabled: !Object.keys(mappings).length,
          },
          {
            title: "Remove mapping",
            value: "remove",
            description: "Remove a source-to-fallback edge",
            disabled: !Object.keys(mappings).length,
          },
          {
            title: circular ? "Break circular route" : "Make route circular",
            value: "circular",
            description: route.length ? route.join(" → ") : "Add a mapping first",
            disabled: route.length < 2,
          },
        ],
      });
      if (!action) return;

      if (action === "add") {
        const source = await chooseModel("Fallback source model");
        if (!source) return;
        const target = await chooseModel(`Fallback for ${source}`, source);
        if (!target) return;
        mappings[source] = target;
        await saveOptions({ mappings });
        return;
      }

      if (action === "edit") {
        const source = await context.ui.dialog.select({
          title: "Mapping to edit",
          options: Object.entries(mappings).map(([model, target]) => ({
            title: model,
            value: model,
            description: `Current fallback: ${target}`,
          })),
        });
        if (!source) return;
        const target = await chooseModel(`New fallback for ${source}`, source);
        if (!target) return;
        mappings[source] = target;
        await saveOptions({ mappings });
        return;
      }

      if (action === "remove") {
        const source = await context.ui.dialog.select({
          title: "Mapping to remove",
          options: Object.entries(mappings).map(([model, target]) => ({
            title: model,
            value: model,
            description: `Fallback: ${target}`,
          })),
        });
        if (!source) return;
        const confirmed = await context.ui.dialog.confirm({
          title: "Remove fallback mapping",
          message: `${source} → ${mappings[source]}`,
        });
        if (!confirmed) return;
        delete mappings[source];
        await saveOptions({ mappings });
        return;
      }

      if (action === "circular") {
        if (circular) delete mappings[route.at(-1)];
        else mappings[route.at(-1)] = route[0];
        await saveOptions({ mappings });
      }
    }

    async function configure() {
      setConfiguring(true);
      try {
        await configureDialog();
      } finally {
        setConfiguring(false);
      }
    }

    function modelView(model, position) {
      const state = () => status()?.models?.[model];
      return card(
        [
          text(
            () => `PRIORITY ${position}${status()?.latest?.model === model ? " [Recent]" : ""}`,
            context.theme.text.muted,
          ),
          text(() => displayModel(model, state()?.variant), context.theme.text.base),
          text(
            () =>
              `Used: ${state()?.lastUsedAt ? relativeTime(state().lastUsedAt) : "never"}${
                state()?.sessionID ? ` · ${state().sessionID}` : ""
              }`,
            context.theme.text.muted,
          ),
          text(
            () =>
              `${errorLabel(state()?.lastError)}${
                state()?.lastError?.at ? ` · ${relativeTime(state().lastError.at)}` : ""
              }`,
            context.theme.text.muted,
          ),
        ],
        context.theme.text.muted,
      );
    }

    function sidebarView() {
      return box([
        text("Model fallback", context.theme.text.base),
        text(
          () =>
            loadError() ??
            (routes().length ? "Mappings in priority order" : "No mappings configured"),
          context.theme.text.muted,
        ),
        jsxDEV(
          For,
          {
            get each() {
              return routes();
            },
            children: (route, routeIndex) =>
              box([
                text(`ROUTE ${routeIndex() + 1} · highest priority first`, context.theme.text.base),
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
      ]);
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "model-fallback.configure",
          title: "Configure model fallback routes",
          group: "Models",
          palette: true,
          slash: { name: "fallback-config" },
          run: configure,
        },
        {
          id: "model-fallback.dialog.close",
          bind: "escape",
          enabled: configuring,
          run: () => context.ui.dialog.clear(),
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
