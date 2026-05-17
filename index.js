import { createMappedFallbackRouter } from "./lib/router.js";

export async function MappedFallbackRouterPlugin(ctx, rawOptions) {
  return createMappedFallbackRouter(ctx, rawOptions);
}

export default MappedFallbackRouterPlugin;
