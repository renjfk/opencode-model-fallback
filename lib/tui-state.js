export function fallbackRoutes(mappings) {
  const edges = Object.entries(mappings ?? {}).filter(
    ([source, target]) => typeof source === "string" && typeof target === "string",
  );
  const targets = new Set(edges.map(([, target]) => target));
  const starts = edges.map(([source]) => source).filter((source) => !targets.has(source));
  const candidates = [...starts, ...edges.map(([source]) => source)];
  const visited = new Set();
  const routes = [];

  for (const start of candidates) {
    if (visited.has(start)) continue;
    const route = [];
    let current = start;
    while (current && !visited.has(current)) {
      visited.add(current);
      route.push(current);
      current = mappings[current];
    }
    if (route.length) routes.push(route);
  }
  return routes;
}

export function activatedRoutes(routes, model) {
  if (!model) return [];
  return routes.filter((route) => route.includes(model));
}

export function displayModel(model, variant) {
  const suffix = variant && variant !== "default" ? `#${variant}` : "";
  return `${model}${suffix}`;
}

export function relativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleString();
}

export function errorLabel(error) {
  if (!error) return "no recent errors";
  const status = error.status ? ` ${error.status}` : "";
  return `${error.type ?? "provider.error"}${status}: ${error.message}`;
}
