export function modelObject(model) {
  const [providerID, ...modelParts] = model.split("/");
  if (!providerID || modelParts.length === 0) return undefined;
  return { providerID, modelID: modelParts.join("/") };
}

export function modelString(model) {
  if (!model?.providerID || !model?.modelID) return undefined;
  return `${model.providerID}/${model.modelID}`;
}
