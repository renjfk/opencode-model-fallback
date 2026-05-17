# AGENTS.md - opencode-model-fallback

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Project overview

**opencode-model-fallback** is an OpenCode TUI plugin that routes configured
models to mapped fallback models when retryable provider failures occur. It
persists global model cooldowns and routes back to the original model after a
cooldown expires.

## Architecture

Single TUI plugin exported from `index.js`, with logic split into modules
under `lib/`.

- `index.js` - entry point, registers chat/session event handlers
- `lib/options.js` - plugin option normalization and defaults
- `lib/router.js` - fallback routing, recovery, timeout, and notification logic
- `lib/store.js` - persisted global model cooldown reads and writes
- `lib/models.js` - model ID helpers
- `lib/errors.js` - retryable error/status matching
- `lib/session.js` - shared helpers for reading OpenCode session metadata

### Key invariants

- Single default export: `{ id, tui }`. OpenCode's TUI loader requires this shape.
- No server-side plugin. The `server` property must never be added.
- Fallback mappings are one-to-one: one original model maps to one fallback model.
- Retryable failures are matched by configured HTTP status codes and error message patterns.
- Active requests are aborted before replaying the latest user message on the fallback model.
- Global model cooldowns are persisted by `lib/store.js`; do not add per-session fallback state.
- Configuration is read from plugin `options`; do not add dotfile-based config reads.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (test, lint, format, build). Releases are manual
dispatch via `gh workflow run release.yml`.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No runtime dependencies** - only dev tooling dependencies for lint/format
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
