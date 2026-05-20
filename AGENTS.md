# AGENTS.md - opencode-model-fallback

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single default export: `{ id, tui }`. No server-side plugin.
- Fallback mappings are one-to-one: one original model maps to one fallback
  model.
- Active requests are aborted before replaying the latest user message on the
  fallback model.
- Global model cooldowns are persisted by `lib/store.js`; do not add
  per-session fallback state.
- Configuration is read from plugin `options`; do not add dotfile-based config
  reads.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run test         # vitest run
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
