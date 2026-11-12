# AGENTS.md - opencode-model-fallback

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Server plugin exported from `index.js` via `Plugin.define` (`@opencode/plugin`)
with logic split into `lib/`.

## Key invariants

- Single default export: `Plugin.define({ id, setup })`. `createMappedFallbackRouter(ctx, options)`
  receives the V2 plugin context; `ctx.options` holds the plugin options.
- Fallback mappings are one-to-one: one original model maps to one fallback
  model. Chains are the transitive composition of mappings and are followed
  transitively; a configured cycle truncates at the first repeat.
- A retryable failure is handled by the V2 session `retry` hook: set the global
  cooldown (unless one is already active), switch the session to the next
  healthy chain member (`ctx.session.switchModel`), and force
  `event.decision = { retry: true }`.
  Routing at prompt time happens through the session `prompt` hook: the
  `context` hook's `model` field is readonly and core ignores writes to it, so
  the switch must happen before the request is built.
- Global model cooldowns are persisted with the V2 `ctx.storage` domain (already
  namespaced per plugin id); do not add per-session fallback state.
- Configuration is read from plugin `ctx.options`; do not add dotfile-based
  config reads.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run test         # vitest run (unit tests; e2e skipped)
npm run test:e2e     # full fallback flow against a real `opencode serve`
                     # with a mock 429 provider (needs opencode on PATH)
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, build). See RELEASE_PROCESS.md for
release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
