export function modelRef(model) {
  const [providerID, ...modelParts] = model.split("/");
  if (!providerID || modelParts.length === 0) return undefined;
  const [id, variant] = modelParts.join("/").split("#");
  if (!id) return undefined;
  return { providerID, id, ...(variant ? { variant } : {}) };
}

export function modelRefString(ref) {
  if (!ref?.providerID || !ref?.id) return undefined;
  return `${ref.providerID}/${ref.id}`;
}
