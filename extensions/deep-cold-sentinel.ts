/**
 * deep-cold-sentinel.ts — a deep context (250k+) that sits idle past the model's
 * cache TTL would be recomputed from scratch at full price on the next LLM call.
 * This aborts that call before it is billed, then auto-compacts: success nudges a
 * "continue" into the small prefix, which recomputes COLD but shallow; a user
 * abort or a failed compaction leaves the verbatim recompute armed for exactly
 * the next send. Same contract as Pi's overflow recovery (persist failed request
 * → compact → re-issue), applied pre-bill instead of post-error.
 *
 * A cue, not a replay: the interrupted submission is already on the branch (Pi
 * persists it before the request), so resuming it needs only a cue, never a copy
 * of its text. A real `agent.continue()` is out of reach — `ctx.abort()` sets the
 * run-abort flag that skips `agent_before_settle`.
 *
 * All data is native — no private meters:
 *   depth  ← ctx.getContextUsage().tokens, floored by the largest prompt the
 *            provider actually billed since the last compaction (Pi's own
 *            compaction-threshold number: last assistant bill + trailing
 *            estimate, null right after compaction). Not the estimate alone:
 *            after a context edit Pi refuses its usage anchor and falls back to
 *            chars/4, which under-counts tool-heavy content by ~2x.
 *   warmth ← one pass over ctx.sessionManager.getBranch(): provider/model → start
 *            of the newest request that model served. The serving request writes
 *            or refreshes the cache at prefill, so the request IS the warmth, not
 *            the cacheRead it reports — these providers never report cache writes,
 *            and a cold prefix reports cacheRead=0 right after being written.
 *            Billed requests carry their own exact ids, so the map answers per
 *            model: this model's timestamp says whether THIS prefix is alive, and
 *            switching back inside the window finds it still fresh with no stored
 *            state. Request start is the earliest possible expiry (the prompt is
 *            known at prefill, while generation streams for minutes after) and the
 *            clock Pi's warmer schedules itself off (0.9x TTL). Errors, aborts and
 *            compaction (a new prefix) reset or contribute nothing.
 *   model  ← warning only: a model with no entry of its own is a switch, and the
 *            newest entry names where the prefix is still cached.
 *
 * Warming is not a dependency: a cache_warm refresh is credited to the request it
 * kept warm (its logged label is the SERVED id, an alias, so it is never
 * compared). Upstream barely warms today — it stops as soon as a
 * custom_message/compaction entry is re-projected, because its prefix check is by
 * object identity (earendil-works/pi#10956) — and if warming returns it only adds
 * fresher entries.
 *
 * One threshold: a cache-touching gap >= the stamped TTL means the guaranteed
 * window has lapsed — stop before billing. A guarantee, not a proof (measured
 * misses do occur inside documented windows), so this errs early by design. One
 * stop per dead window; an explicit re-send overrides it.
 *
 * No self-suppression mode is needed while compacting: neither summarizer path
 * traverses this hook (stock compaction passes the agent's stream function and
 * refine-compact calls modelRegistry.complete, while context_with_system is
 * dispatched from the agent loop's transformContext). If a future Pi did route a
 * summarizer through here, the abort would land on the intended
 * compaction-failed → verbatim path, not a silent loop.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEEP = 250_000;
/** A cross-model warning repeats at most this often; a model switch is not news after the first notice. */
const WARN_EVERY = 5 * 60_000;

const k = (n: number) => `${(n / 1000).toFixed(0)}k`;
const state = {
  /** We already stopped once for this dead window — next attempt goes through. */
  stoppedOnce: false,
  /** When the cross-model warning last fired, so it cannot repeat per request. */
  lastWarnAt: 0,
};
/** Continuation sent into the compacted prefix — the ask is already in it. */
const CONTINUE_CUE = "continue";

const ttlMs = (ctx: ExtensionContext) => {
  const short = ctx.model?.promptCache?.short;
  return short && short > 0 ? short * 1000 : undefined;
};

/** provider/model → start (epoch ms) of the newest request that model served. */
type Warmth = {
  map: Map<string, number>;
  /** Biggest prompt the provider actually billed since the last compaction. */
  billed: number;
};

/**
 * Per-model cache warmth over the active branch, plus the exact context size the
 * provider reported. Compaction starts a new prefix, so it resets both.
 */
const warmth = (ctx: ExtensionContext): Warmth => {
  const map = new Map<string, number>();
  let last: string | undefined;
  let billed = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "compaction" || e.type === "branch_summary") {
      map.clear();
      last = undefined;
      billed = 0;
      continue;
    }
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message;
      const answered = m.stopReason !== "aborted" && m.stopReason !== "error" && m.stopReason !== "deferred" && m.stopReason !== "pending";
      if (!answered || m.timestamp <= 0) continue;
      // Server-reported prompt size — no heuristic, and independent of caching.
      billed = Math.max(billed, m.usage.input + m.usage.cacheRead + m.usage.cacheWrite);
      // Serving the prompt is what writes/refreshes the cache, so the request is
      // the warmth; requiring cacheRead would lag one request behind.
      last = `${m.provider}/${m.model}`;
      map.set(last, m.timestamp);
    } else if (e.type === "usage" && e.kind === "cache_warm") {
      const at = Date.parse(e.timestamp);
      if (last && Number.isFinite(at)) map.set(last, Math.max(at, map.get(last) ?? 0));
    }
  }
  return { map, billed };
};

/** Where the prefix was last touched — the switch warning names this model. */
const newestKey = (map: Map<string, number>) => {
  let key: string | undefined;
  let at = -Infinity;
  for (const [k, ts] of map) if (ts > at) { at = ts; key = k; }
  return key;
};

/** Identity of the active model — the key a cache anchor is attributed to. */
const currentKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

export default function (pi: ExtensionAPI) {
  /** Before every LLM call — incl. resuming a run after a late ask_user_question answer. */
  pi.on("context_with_system", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const ttl = ttlMs(ctx);
    const key = currentKey(ctx);
    if (!ttl || !key) return;
    const { map, billed } = warmth(ctx);
    const depth = Math.max(billed, ctx.getContextUsage()?.tokens ?? 0);
    if (depth < DEEP) {
      // A /compact landed since: drop a stale suppression so it cannot skip a
      // future guard in this session.
      state.stoppedOnce = false;
      return;
    }
    const mine = map.get(key);
    // Not billed on this model since the last compaction, so this request rebuilds
    // the prefix here. The switch was the user's choice — warn, never stop — and
    // it also voids an arm from the previous selection: a switch is not a re-send.
    if (mine === undefined) {
      state.stoppedOnce = false;
      const elsewhere = newestKey(map);
      if (elsewhere && Date.now() - state.lastWarnAt >= WARN_EVERY) {
        state.lastWarnAt = Date.now();
        ctx.ui.notify(
          `Deep prefix (${k(depth)}) is cached for ${elsewhere}, not ${key} — this request recomputes it fresh here. /compact if the depth is no longer needed.`,
          "warning",
        );
      }
      return;
    }
    const gap = Date.now() - mine;
    if (gap < ttl) { state.stoppedOnce = false; return; } // the dead window closed
    // Already stopped once for this window: the explicit re-send overrides it. The
    // arm stands until warmth actually returns — a cold pass-through refreshes no
    // timestamp, so clearing here would let the very next call stop again in the
    // same window.
    if (state.stoppedOnce) return;
    // Abandoned from our side: the request never goes out, and aborted attempts are
    // NOT warmth.
    ctx.abort();
    // The guaranteed window has lapsed, so compaction beats a billed recompute:
    // success continues into a small COLD prefix and disarms below DEEP; a user
    // abort (Esc) or failure keeps stoppedOnce armed for one verbatim send.
    state.stoppedOnce = true;
    ctx.ui.notify(
      `Stopped before billing: deep prefix (${k(depth)}) cache expired after ${Math.round(gap / 60_000)} min idle — auto-compacting (Esc to send verbatim instead).`,
      "warning",
    );
    ctx.compact({
      onComplete: () => {
        state.stoppedOnce = false;
        // Compacted context starts a fresh, smaller baseline: getContextUsage() is
        // null until this cue's response lands, so the guard stays calm.
        //
        // Unless something newer is already running: compaction releases the idle
        // wait before onComplete, and that prompt's intent wins.
        if (!ctx.isIdle()) {
          ctx.ui.notify("Compacted — continuing with your newer prompt instead.", "info");
          return;
        }
        ctx.ui.notify("Compacted — continuing in the small prefix.", "info");
        // Fire-and-forget; a rejection surfaces through Pi. Safe here because
        // ctx.compact() awaits compact() (controller cleared) before onComplete.
        pi.sendUserMessage(CONTINUE_CUE);
      },
      // Esc, a cancellation and a genuine summarizer failure all throw out of
      // compact() into here; stoppedOnce stays armed for one verbatim send.
      onError: () => {
        ctx.ui.notify("Auto-compaction did not finish — next send goes verbatim and reloads the deep prefix fresh.", "warning");
      },
    });
  });

  pi.on("session_start", () => {
    // Suppression never outlives the session it was armed in.
    state.stoppedOnce = false;
  });

  pi.registerCommand("deep-cold", {
    description: "Show deep-context cache protection state",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const ttl = ttlMs(ctx);
      const key = currentKey(ctx);
      if (!ttl || !key) return void ctx.ui.notify(`Deep context: no cache lifetime for this model.`, "info");
      const { map, billed } = warmth(ctx);
      const depth = Math.max(billed, ctx.getContextUsage()?.tokens ?? 0);
      if (depth < DEEP) return void ctx.ui.notify("No deep context (>=250k tokens) tracked. Nothing to protect.", "info");
      const mine = map.get(key);
      const elsewhere = newestKey(map);
      if (mine === undefined)
        return void ctx.ui.notify(
          `Deep context: ${k(depth)} tokens. No cache here${elsewhere ? `; last touched on ${elsewhere}` : ""}. The next request recomputes it fresh.`,
          "info",
        );
      const age = Math.round((Date.now() - mine) / 60_000);
      const status = Date.now() - mine < ttl ? `alive (${age} min idle)` : `EXPIRED (${age} min idle) — the next request recomputes it fresh`;
      const armed = state.stoppedOnce ? " Stop armed — re-send overrides." : "";
      ctx.ui.notify(`Deep context: ${k(depth)} tokens. Cache: ${status}.${armed}`, "info");
    },
  });
}
