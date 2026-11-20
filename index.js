import { Plugin } from "@opencode/plugin";

import { createMappedFallbackRouter } from "./lib/router.js";
import { ModelFallback } from "./rpc.js";

export default Plugin.define({
  id: "model-fallback",
  async setup(ctx) {
    const router = createMappedFallbackRouter(ctx, ctx.options);
    const status = () => ({ ...router.status(), mappings: ctx.options.mappings ?? {} });
    const registration = await ctx.rpc.register(ModelFallback, {
      status: async () => status(),
    });
    const unsubscribe = router.subscribe(() => registration.events.emit("updated", status()));
    const cleanup = await router.setup(ctx);
    return async () => {
      unsubscribe();
      await cleanup();
      await registration.dispose();
    };
  },
});
