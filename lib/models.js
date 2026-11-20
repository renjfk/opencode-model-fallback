export function modelRef(model, variant) {
  const [providerID, ...modelParts] = model.split("/");
  const idAndVariant = modelParts.join("/");
  const [id, inlineVariant] = idAndVariant.split("#");
  const selectedVariant = inlineVariant || variant;
  if (!providerID || !id) return undefined;
  return { providerID, id, ...(selectedVariant ? { variant: selectedVariant } : {}) };
}

export function modelRefString(ref) {
  if (!ref?.providerID || !ref?.id) return undefined;
  return `${ref.providerID}/${ref.id}`;
}
