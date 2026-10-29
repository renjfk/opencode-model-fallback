import { Plugin } from "@opencode/plugin";

import { createMappedFallbackRouter } from "./lib/router.js";

export default Plugin.define({
  id: "model-fallback",
  async setup(ctx) {
    const router = createMappedFallbackRouter(ctx, ctx.options);
    return router.setup(ctx);
  },
});
