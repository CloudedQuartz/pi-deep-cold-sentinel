/**
 * Regression: the cross-model warning fired once per LLM call (observed: 5 in
 * 5 calls). It must repeat at most once per WARN_EVERY window, and it must
 * never abort — switching models is the user's choice.
 */
import { expect, test } from "bun:test";
import sentinel from "../extensions/deep-cold-sentinel.ts";

const DEEP_TOKENS = 300_000;

function harness(now: { t: number }) {
  const notified: string[] = [];
  let aborts = 0;
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6.1-sol",
        stopReason: "stop",
        timestamp: now.t - 2 * 60 * 60 * 1000,
        usage: { input: DEEP_TOKENS, cacheRead: 0, cacheWrite: 0 },
      },
      timestamp: now.t - 2 * 60 * 60 * 1000,
    },
  ];
  const ctx: any = {
    hasUI: true,
    model: { provider: "opencode-go", id: "muse-spark", promptCache: { short: 300 } },
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => ({ tokens: DEEP_TOKENS }),
    ui: { notify: (msg: string) => void notified.push(msg) },
    abort: () => void aborts++,
    compact: () => {},
    isIdle: () => true,
  };
  let handler: any;
  sentinel({ on: (name: string, fn: any) => { if (name === "context_with_system") handler = fn; }, registerCommand: () => {} } as any);
  return { call: () => handler({}, ctx), notified, aborts: () => aborts };
}

test("cross-model warning is throttled and never aborts", () => {
  const realNow = Date.now;
  const now = { t: realNow() };
  Date.now = () => now.t;
  try {
    const h = harness(now);
    for (let i = 0; i < 5; i++) h.call();
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("recomputes it fresh here");
    expect(h.aborts()).toBe(0);
    now.t += 4 * 60_000;
    h.call();
    expect(h.notified).toHaveLength(1);
    now.t += 2 * 60_000;
    h.call();
    expect(h.notified).toHaveLength(2);
    expect(h.aborts()).toBe(0);
  } finally {
    Date.now = realNow;
  }
});

test("an expired window still aborts exactly once and re-arms after compaction", () => {
  const realNow = Date.now;
  const now = { t: realNow() };
  Date.now = () => now.t;
  try {
    const h = harness({ t: now.t });
    // Same model as the anchor: the window is dead (ttl 300s, idle 2h).
    const stale = (h as any);
    void stale;
    let handler: any;
    const branch = [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "muse-spark",
          stopReason: "stop",
          timestamp: now.t - 2 * 60 * 60 * 1000,
          usage: { input: DEEP_TOKENS, cacheRead: 0, cacheWrite: 0 },
        },
        timestamp: now.t - 2 * 60 * 60 * 1000,
      },
    ];
    let compacts = 0;
    const ctx: any = {
      hasUI: true,
      model: { provider: "opencode-go", id: "muse-spark", promptCache: { short: 300 } },
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => ({ tokens: DEEP_TOKENS }),
      ui: { notify: (msg: string) => h.notified.push(msg) },
      abort: () => h.aborts(),
      compact: () => void compacts++,
      isIdle: () => true,
    };
    sentinel({ on: (n: string, fn: any) => { if (n === "context_with_system") handler = fn; }, registerCommand: () => {} } as any);
    handler({}, ctx);
    handler({}, ctx);
    expect(compacts).toBe(1);
    expect(h.notified.some((m) => m.includes("Stopped before billing"))).toBe(true);
  } finally {
    Date.now = realNow;
  }
});
