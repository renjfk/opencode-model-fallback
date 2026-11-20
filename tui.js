import { Plugin } from "@opencode/plugin/tui";
import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";
import { createSignal, For, Show } from "solid-js";
import { updateFallbackOptions } from "./lib/config-file.js";
import { moveModel, replaceRoute, routeEdges, routeIsCircular } from "./lib/route-editor.js";
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

    async function modelOptions(exclude) {
      const location = context.location ?? context.data.location.default();
      const result = await context.data.location.model.list(location);
      const models = Array.isArray(result) ? result : (result?.data ?? []);
      const excluded = new Set(Array.isArray(exclude) ? exclude : [exclude]);
      return models
        .filter((model) => model.enabled !== false && model.type === "chat")
        .map((model) => `${model.providerID}/${model.id}`)
        .filter((model) => !excluded.has(model))
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
      const routes = fallbackRoutes(mappings);
      const allModels = [...new Set(routes.flat())];

      async function createRoute() {
        const primary = await chooseModel("New route · primary model", allModels);
        if (!primary) return;
        const fallback = await chooseModel("New route · first fallback", [...allModels, primary]);
        if (!fallback) return;
        await saveOptions({ mappings: { ...mappings, ...routeEdges([primary, fallback], false) } });
      }

      if (!routes.length) {
        await createRoute();
        return;
      }

      const selected = context.ui.model.current();
      const selectedModel = selected ? `${selected.providerID}/${selected.modelID}` : undefined;
      const currentRoute = Math.max(
        0,
        routes.findIndex((route) => route.includes(selectedModel)),
      );
      const routeIndex =
        routes.length === 1
          ? 0
          : Number(
              await context.ui.dialog.select({
                title: "Fallback route to edit",
                current: String(currentRoute),
                options: routes.map((route, index) => ({
                  title: `Route ${index + 1} · ${route.length} models`,
                  value: String(index),
                  description: route.join(" → "),
                })),
              }),
            );
      if (!Number.isInteger(routeIndex) || !routes[routeIndex]) return;
      const route = routes[routeIndex];
      const circular = routeIsCircular(mappings, route);
      const action = await context.ui.dialog.select({
        title: `Edit Route ${routeIndex + 1}`,
        current: "add",
        options: [
          {
            title: "Add model",
            value: "add",
            description: "Append a model at the lowest priority",
          },
          {
            title: "Reorder priority",
            value: "move",
            description: "Move a model earlier or later in the retry order",
          },
          {
            title: "Replace model",
            value: "replace",
            description: "Swap one model without changing the other positions",
          },
          {
            title: "Remove model",
            value: "remove",
            description: "Remove a model and reconnect the remaining route",
          },
          {
            title: `Circular retry: ${circular ? "on" : "off"}`,
            value: "circular",
            description: circular
              ? `Turn off the final retry back to ${route[0]}`
              : `Turn on a final retry from ${route.at(-1)} to ${route[0]}`,
          },
          {
            title: "Create another route",
            value: "create",
            description: "Start an independent primary/fallback route",
          },
          { title: "Delete this route", value: "delete", description: route.join(" → ") },
        ],
      });
      if (!action) return;

      if (action === "create") {
        await createRoute();
        return;
      }
      if (action === "add") {
        const model = await chooseModel("Model to add at lowest priority", route);
        if (!model) return;
        await saveOptions({ mappings: replaceRoute(mappings, route, [...route, model], circular) });
        return;
      }
      if (action === "circular") {
        await saveOptions({ mappings: replaceRoute(mappings, route, route, !circular) });
        return;
      }
      if (action === "delete") {
        const confirmed = await context.ui.dialog.confirm({
          title: "Delete fallback route",
          message: route.join(" → "),
          label: { confirm: "Delete route" },
        });
        if (confirmed) await saveOptions({ mappings: replaceRoute(mappings, route, [], false) });
        return;
      }

      const model = await context.ui.dialog.select({
        title: `Select model in Route ${routeIndex + 1}`,
        options: route.map((item, index) => ({
          title: `${index + 1}. ${item}`,
          value: item,
          description:
            index === route.length - 1 ? "Lowest priority" : `Falls back to ${route[index + 1]}`,
        })),
      });
      if (!model) return;

      if (action === "move") {
        const priority = await context.ui.dialog.select({
          title: `New priority for ${model}`,
          options: route.map((item, index) => ({
            title: `Priority ${index + 1}`,
            value: String(index + 1),
            description: item === model ? "Current position" : `Currently ${item}`,
          })),
        });
        if (!priority) return;
        await saveOptions({
          mappings: replaceRoute(
            mappings,
            route,
            moveModel(route, model, Number(priority)),
            circular,
          ),
        });
        return;
      }
      if (action === "replace") {
        const replacement = await chooseModel(
          `Replacement for ${model}`,
          route.filter((item) => item !== model),
        );
        if (!replacement) return;
        const next = route.map((item) => (item === model ? replacement : item));
        await saveOptions({ mappings: replaceRoute(mappings, route, next, circular) });
        return;
      }
      if (action === "remove") {
        const next = route.filter((item) => item !== model);
        const confirmed = await context.ui.dialog.confirm({
          title: `Remove ${model}`,
          message: next.length
            ? `New route: ${next.join(" → ")}`
            : "This removes the entire route.",
          label: { confirm: "Remove model" },
        });
        if (confirmed)
          await saveOptions({ mappings: replaceRoute(mappings, route, next, circular) });
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
