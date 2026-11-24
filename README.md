# pi-deep-cold-sentinel

Pre-billing guard for deep context that outlived its prompt-cache window:
`context_with_system` aborts the request, auto-compacts, and continues in the
small prefix; `/deep-cold` reports state.

- Entry: `extensions/deep-cold-sentinel.ts`.
- Hooks: `context_with_system`, `session_start`; command `deep-cold`.

## Install

Symlink or copy `extensions/deep-cold-sentinel.ts` into `~/.pi/agent/extensions/`.

## Tests

```sh
bun test
```

2 pass, 0 fail. The test stubs `Date.now`, a fake branch, and a fake `ctx`; no
session, network, or provider call.

## Dependency / behavior constraints

- Reads `ctx.model.promptCache.short` for the TTL. In practice those values are
  supplied by `prompt-cache-stamp` (opencode-go/opencode/openai-codex); without
  it the guard is inert. This is a runtime dependency, not a code import.
- Relies on Pi's `context_with_system` dispatch from the agent loop, `ctx.abort`,
  `ctx.compact({onComplete,onError})`, `ctx.isIdle`, and `pi.sendUserMessage`.
- No machine-specific paths, credentials, or personal settings.
