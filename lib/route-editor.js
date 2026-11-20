export function routeIsCircular(mappings, route) {
  return route.length > 1 && mappings[route[route.length - 1]] === route[0];
}

export function routeEdges(route, circular) {
  const mappings = {};
  for (const [index, model] of route.entries()) {
    if (index < route.length - 1) mappings[model] = route[index + 1];
  }
  if (circular && route.length > 1) mappings[route[route.length - 1]] = route[0];
  return mappings;
}

export function replaceRoute(mappings, original, replacement, circular) {
  const updated = { ...mappings };
  for (const model of original) delete updated[model];
  return { ...updated, ...routeEdges(replacement, circular) };
}

export function moveModel(route, model, priority) {
  const next = route.filter((item) => item !== model);
  next.splice(Math.max(0, Math.min(priority - 1, next.length)), 0, model);
  return next;
}
