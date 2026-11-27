# pi-deep-cold-sentinel

Pre-billing gate for deep context served cold: the agent loop awaits
`context_with_system` and uses its return as the request payload, so a cold deep
request is held there and asked once, by name — send as-is, or compact — with
the stakes spelled out in the option labels themselves.
The dialog auto-dismisses after 10 s (native `timeout`, with a live countdown),
and no answer — countdown expiry or escape — takes the case's default: a lapsed
cache window compacts, and a model switch sends as-is, so unattended runs carry
themselves.
Nothing warm or shallow is ever touched; `/deep-cold` reports state.

- Entry: `extensions/deep-cold-sentinel.ts`.
- Hook: `context_with_system`; command `deep-cold`.

## Install

Symlink or copy `extensions/deep-cold-sentinel.ts` into `~/.pi/agent/extensions/`.

## Tests

```sh
bun test
```

7 pass, 0 fail. The tests stub `Date.now`, a fake branch, and a fake `ctx`;
no session, network, provider call, or real timers.

## Dependency / behavior constraints

- Reads `ctx.model.promptCache.short` for the TTL. In practice those values are
  supplied by `prompt-cache-stamp` (opencode-go/opencode/openai-codex); without
  it the gate is inert. This is a runtime dependency, not a code import.
- Relies on Pi's `context_with_system` dispatch from the agent loop (awaited; the
  handler's return is the request payload), `ctx.ui.select` (with its native
  dialog `timeout`), `ctx.abort`,
  `ctx.compact({onComplete,onError})`, `ctx.isIdle`, and `pi.sendUserMessage`.
- No machine-specific paths, credentials, or personal settings.
