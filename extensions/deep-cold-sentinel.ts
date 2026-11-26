/**
 * deep-cold-sentinel.ts — a deep context (250k+) served cold would be recomputed
 * from scratch at full price. The agent loop awaits `context_with_system` and
 * uses its return as the request payload, so the hook itself is the gate: a cold
 * deep request is HELD there and asked once, by name — send as-is, or compact —
 * and silence takes the case's default (expired → compacted, model switch → as-is).
 * Nothing cold bills silently; nothing warm is touched.
 *
 * All data is native — no private meters:
 *   depth  ← ctx.getContextUsage().tokens, floored by the largest prompt the
 *            provider actually billed since the last compaction. Not the estimate
 *            alone: after a context edit Pi refuses its usage anchor and falls
 *            back to chars/4, which under-counts tool-heavy content by ~2x.
 *   warmth ← one pass over ctx.sessionManager.getBranch(): provider/model → start
 *            of the newest request that model served. The serving request writes
 *            or refreshes the cache at prefill, so the request IS the warmth.
 *            Request start is the earliest possible expiry and the clock Pi's
 *            warmer schedules itself off (0.9x TTL). A model with no entry of
 *            its own is a switch; the newest entry names where the prefix is
 *            still cached.
 *
 * A cue, not a replay: the held submission is already on the branch (Pi persists
 * it before the request), so continuing after compaction needs only a cue.
 * Compaction itself never traverses this hook (stock compaction passes the
 * agent's stream function; refine-compact calls modelRegistry.complete), so the
 * gate cannot loop. No module state: warmth is re-derived from the branch, and
 * every decision is made once, inside the held request.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEEP = 250_000;
/** How long the gate waits for an answer before taking the case's default. */
const PROMPT_TIMEOUT_MS = 30_000;
/** Continuation sent into the compacted prefix — the ask is already in it. */
const CONTINUE_CUE = "continue";

const k = (n: number) => `${(n / 1000).toFixed(0)}k`;

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

/** Where the prefix was last touched — the switch question names this model. */
const newestKey = (map: Map<string, number>) => {
  let key: string | undefined;
  let at = -Infinity;
  for (const [k, ts] of map) if (ts > at) { at = ts; key = k; }
  return key;
};

/** Identity of the active model — the key a cache anchor is attributed to. */
const currentKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

/** Ask once, by name; the request is held while deciding, and silence takes the default. */
const askHow = async (ctx: ExtensionContext, title: string, options: string[], defaultIndex: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(options[defaultIndex]), PROMPT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ctx.ui.select(title, options), silence]);
  } finally {
    clearTimeout(timer);
  }
};

export default function (pi: ExtensionAPI) {
  /** The gate: the agent loop awaits this handler and sends what it returns. */
  pi.on("context_with_system", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const ttl = ttlMs(ctx);
    const key = currentKey(ctx);
    if (!ttl || !key) return;
    const { map, billed } = warmth(ctx);
    const depth = Math.max(billed, ctx.getContextUsage()?.tokens ?? 0);
    if (depth < DEEP) return;
    const mine = map.get(key);
    if (mine !== undefined && Date.now() - mine < ttl) return; // warm — free pass

    const elsewhere = newestKey(map);
    if (mine === undefined && !elsewhere) return; // no warmth anywhere to compare
    const switched = mine === undefined;
    const idleMin = mine !== undefined ? Math.round((Date.now() - mine) / 60_000) : 0;
    const options = [
      `Send as-is — recompute ${k(depth)} tokens at full input price`,
      "Compact first — summarize, then continue small",
    ];
    const title = switched
      ? `Deep prefix (${k(depth)}) is cached for ${elsewhere}, not ${key} — send as-is, or compact first?`
      : `Deep prefix (${k(depth)}) cache expired (${idleMin} min idle) — send as-is, or compact first?`;
    // Silence: a deliberate switch expects the verbatim send; a lapsed window
    // expects the compact that keeps the run small.
    if ((await askHow(ctx, title, options, switched ? 0 : 1)) === options[0]) return;

    // Compacted: stop the held request before it bills, then continue small.
    ctx.abort();
    ctx.ui.notify(`Compacting the deep prefix (${k(depth)}) — the ask is preserved.`, "info");
    ctx.compact({
      onComplete: () => {
        // Compaction releases the idle wait before onComplete; a newer prompt's
        // intent wins over the cue.
        if (!ctx.isIdle()) {
          ctx.ui.notify("Compacted — continuing with your newer prompt instead.", "info");
          return;
        }
        ctx.ui.notify("Compacted — continuing in the small prefix.", "info");
        pi.sendUserMessage(CONTINUE_CUE);
      },
      onError: () => {
        ctx.ui.notify("Compaction did not finish — nothing was sent. Re-send when ready.", "warning");
      },
    });
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
          `Deep context: ${k(depth)} tokens. No cache here${elsewhere ? `; last touched on ${elsewhere}` : ""}. A request is held and asked: send as-is, or compact.`,
          "info",
        );
      const age = Math.round((Date.now() - mine) / 60_000);
      const status =
        Date.now() - mine < ttl
          ? `alive (${age} min idle)`
          : `EXPIRED (${age} min idle) — the next request is held and asked: compact, or send as-is`;
      ctx.ui.notify(`Deep context: ${k(depth)} tokens. Cache: ${status}.`, "info");
    },
  });
}
