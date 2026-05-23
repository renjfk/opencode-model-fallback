[![CI](https://github.com/renjfk/opencode-model-fallback/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-model-fallback/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-model-fallback)](https://www.npmjs.com/package/@renjfk/opencode-model-fallback)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-model-fallback)](https://www.npmjs.com/package/@renjfk/opencode-model-fallback)

# opencode-model-fallback

Mapped model fallback router for [OpenCode](https://opencode.ai/).

There are situations where you may want to use the quota that comes with a
subscription first, then fall back to an API pay-as-you-go model only when that
subscription-backed model is rate-limited or usage-limited. You can solve that
with a local proxy, but maintaining a proxy server is often not worth it if all
you need is a simple one-to-one fallback inside OpenCode. This plugin handles
that routing directly in OpenCode.

When a configured model hits a retryable provider failure, this plugin aborts
the in-flight request, replays the latest user message on the mapped fallback
model, persists a global cooldown for the failed model, and routes back to the
original model after the cooldown expires.

## Install

Add to your OpenCode config at `~/.config/opencode/config.json`:

```json
{
  "plugin": ["@renjfk/opencode-model-fallback"]
}
```

## Configuration

If you want to set plugin options, use the tuple form:

```json
{
  "plugin": [
    [
      "@renjfk/opencode-model-fallback",
      {
        "mappings": {
          "openai/gpt-5.4": "azure-ai-foundry/gpt-5.4",
          "openai/gpt-5.5": "azure-ai-foundry/gpt-5.5"
        }
      }
    ]
  ]
}
```

## Options

- `mappings`: map original model IDs to fallback model IDs.
- `retry_on_errors`: retryable HTTP status codes. Defaults to `429`.
- `retryable_error_patterns`: retryable error message patterns. Defaults to `["rate.?limit"]`.
- `cooldown_seconds`: how long a failed original model remains on fallback. Defaults to `3600`.
- `notify_on_fallback`: show fallback/recovery toasts. Defaults to `true`.

## How it works

The plugin watches OpenCode chat and session events. When a request uses a model
listed in `mappings`, that model is preferred unless it has an active global
cooldown. If OpenCode reports a retryable provider failure, the plugin switches
to the mapped fallback model and stores a global cooldown for the failed model.

Global model cooldowns are persisted at:

```
~/.local/share/opencode/mapped-fallback-router.json
```

Persisted cooldowns let all sessions avoid immediately retrying a model that has
just failed. When the cooldown expires, mapped requests are routed back to the
original model.

The plugin does not load balance, race models, or retry through a chain. Each
mapping is one original model to one fallback model.

## Scenarios

### Normal request

If you send a message with `openai/gpt-5.5` and the model has a mapping, the
request goes to `openai/gpt-5.5` normally unless it has an active cooldown.
If you select the mapped fallback model directly, the plugin still routes back
to the original model unless the original has an active cooldown.

### Retryable failure while streaming

If OpenCode reports a retryable provider failure such as a rate limit or a
configured retryable status code, the plugin aborts the current request and
replays the latest user message on the mapped fallback model.

For example:

```json
{
  "mappings": {
    "openai/gpt-5.5": "azure-ai-foundry/gpt-5.5"
  }
}
```

If `openai/gpt-5.5` fails with a retryable error, the session continues on
`azure-ai-foundry/gpt-5.5`.

### Active cooldown

After fallback is triggered, the original model is considered cooling down for
`cooldown_seconds`. During that cooldown, mapped requests use the fallback model
instead of switching back and immediately hitting the same provider
failure again.

All sessions are routed straight to the fallback while the original model is
cooling down.

### Recovery

When the cooldown expires, mapped requests switch back to the original model.

### Exhausted fallback

Mappings are one-to-one. If the fallback model also hits a retryable failure,
there is no next fallback to try. The plugin shows a fallback exhausted toast
when notifications are enabled.

## Troubleshooting Retry Matching

Use OpenCode's provider logs to find the exact status code, headers, and error
body returned by a provider. This is the most reliable way to tune
`retry_on_errors` and `retryable_error_patterns`.

For a short headless reproduction, capture logs and stop the run after a few
seconds to avoid long retry loops:

```bash
log="/tmp/opencode-provider.log"
: > "$log"
opencode run --print-logs --log-level DEBUG --model openai/gpt-5.3-codex --format json "Reply with OK only." 2> "$log" &
pid=$!
sleep 3
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
```

Then inspect the captured provider errors:

```bash
rg 'service=llm|AI_APICallError|statusCode|responseBody|x-codex|reset|usage_limit|rate.?limit' /tmp/opencode-provider.log
```

Look for an OpenCode log line like:

```text
ERROR ... service=llm providerID=openai modelID=gpt-5.3-codex ... error={...}
```

Inside `error`, check fields such as `statusCode`, `responseHeaders`,
`responseBody`, `isRetryable`, and `data.error.message`. For example, OpenAI
usage limits can appear as `statusCode: 429` with a response body containing
`usage_limit_reached` and `The usage limit has been reached`. OpenAI Codex
responses can also include reset headers such as `x-codex-primary-reset-at`,
`x-codex-primary-reset-after-seconds`, `x-codex-secondary-reset-at`, and
`x-codex-secondary-reset-after-seconds`.

For TUI sessions, start OpenCode the same way and reproduce manually:

```bash
opencode --print-logs --log-level DEBUG 2> /tmp/opencode-provider.log
```

Use the provider `statusCode` and response body text to tune the retry rules:

```json
{
  "plugin": [
    [
      "@renjfk/opencode-model-fallback",
      {
        "retry_on_errors": [429, 403],
        "retryable_error_patterns": ["rate.?limit", "usage.?limit"],
        "mappings": {
          "openai/gpt-5.5": "azure-ai-foundry/gpt-5.5"
        }
      }
    ]
  ]
}
```

If the status code is not in `retry_on_errors`, add it. If the response body has
stable text or an error type, add a small regex matching it to
`retryable_error_patterns`. If there is no `service=llm` error line, OpenCode did
not reach the provider or the run was stopped before the provider returned.

## Contributing

opencode-model-fallback is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run test         # node test suite
npm run check        # test + lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Test local plugin in OpenCode

To test unpublished changes in the OpenCode TUI, point `~/.config/opencode/config.json`
at the local repo path, not the npm package name:

```json
{
  "plugin": ["/Users/your-user/opencode-model-fallback/index.js"]
}
```

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
