export function modelRef(model) {
  const [providerID, ...modelParts] = model.split("/");
  if (!providerID || modelParts.length === 0) return undefined;
  return { providerID, id: modelParts.join("/") };
}

export function modelRefString(ref) {
  if (!ref?.providerID || !ref?.id) return undefined;
  return `${ref.providerID}/${ref.id}`;
}
