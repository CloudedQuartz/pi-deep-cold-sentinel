/**
 * The gate: a cold deep request is held and asked once — send as-is, or compact —
 * with silence taking the case's default (expired → compacted, switched → as-is).
 * Nothing warm or shallow is ever gated.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import sentinel from "../extensions/deep-cold-sentinel.ts";

const DEEP_TOKENS = 300_000;
const TTL_SECONDS = 300;

interface Served {
  provider: string;
  model: string;
  ts: number;
}

/** Branch entries for models that served the deep prefix. */
const served = (entries: Served[]) =>
  entries.map((e) => ({
    type: "message",
    message: {
      role: "assistant",
      provider: e.provider,
      model: e.model,
      timestamp: e.ts,
      stopReason: "stop",
      usage: { input: DEEP_TOKENS, cacheRead: 0, cacheWrite: 0 },
    },
  }));

const now = { t: 1_700_000_000_000 };
const realNow = Date.now;

beforeAll(() => {
  Date.now = () => now.t;
});

afterAll(() => {
  Date.now = realNow;
});

function harness(opts: {
  branch: ReturnType<typeof served>;
  model: { provider: string; id: string };
  answer?: (options: string[]) => Promise<string>;
  usageTokens?: number;
}) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
  const notified: string[] = [];
  const askTitles: string[] = [];
  const askOptions: string[][] = [];
  const askDialogOpts: Array<Record<string, unknown>> = [];
  let aborts = 0;
  let askCalls = 0;
  let compacts = 0;
  let cues = 0;
  const pi = {
    on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers[event] = fn;
    },
    registerCommand: () => {},
    sendUserMessage: () => {
      cues++;
    },
  };
  const ctx = {
    hasUI: true,
    model: { ...opts.model, promptCache: { short: TTL_SECONDS } },
    sessionManager: { getBranch: () => opts.branch },
    getContextUsage: () => ({ tokens: opts.usageTokens ?? DEEP_TOKENS }),
    ui: {
      notify: (m: string) => notified.push(m),
      select: (title: string, options: string[], dialogOpts: Record<string, unknown>) => {
        askCalls++;
        askTitles.push(title);
        askOptions.push(options);
        askDialogOpts.push(dialogOpts);
        // No answer — the dialog's own countdown or an escape — resolves undefined.
        return opts.answer ? opts.answer(options) : Promise.resolve(undefined);
      },
    },
    abort: () => {
      aborts++;
    },
    compact: (o: { onComplete: () => void }) => {
      compacts++;
      o.onComplete();
    },
    isIdle: () => true,
  };
  sentinel(pi as never);
  return {
    handlers,
    ctx,
    counts: () => ({ aborts, askCalls, compacts, cues }),
    notified,
    askTitles,
    askOptions,
    askDialogOpts,
  };
}

test("a warm deep request passes through ungated", async () => {
  const h = harness({
    branch: served([{ provider: "openai", model: "sol", ts: now.t - 60_000 }]),
    model: { provider: "openai", id: "sol" },
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 0, askCalls: 0, compacts: 0, cues: 0 });
});

test("shallow context is never gated", async () => {
  const h = harness({
    branch: served([{ provider: "openai", model: "sol", ts: now.t - 60_000 }]),
    model: { provider: "openai", id: "sol" },
    usageTokens: 50_000,
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 0, askCalls: 0, compacts: 0, cues: 0 });
});

test("an expired prefix is held and asked; as-is lets the request through", async () => {
  const h = harness({
    branch: served([{ provider: "openai", model: "sol", ts: now.t - 10 * 60_000 }]),
    model: { provider: "openai", id: "sol" },
    answer: async (o) => o[0],
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 0, askCalls: 1, compacts: 0, cues: 0 });
  expect(h.askTitles[0]).toContain("cache expired");
  expect(h.askTitles[0]).toContain("send as-is, or compact first?");
  expect(h.askOptions[0][0]).toContain("Send as-is");
  expect(h.askOptions[0][1]).toContain("Compact first");
});

test("answering compact on an expired prefix stops the request and continues small", async () => {
  const h = harness({
    branch: served([{ provider: "openai", model: "sol", ts: now.t - 10 * 60_000 }]),
    model: { provider: "openai", id: "sol" },
    answer: async (o) => o[1],
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 1, askCalls: 1, compacts: 1, cues: 1 });
  expect(h.notified.some((m) => m.includes("Compacting"))).toBe(true);
});

test("a timed-out or escaped ask on an expired prefix defaults to compacting", async () => {
  const h = harness({
    branch: served([{ provider: "openai", model: "sol", ts: now.t - 10 * 60_000 }]),
    model: { provider: "openai", id: "sol" },
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 1, askCalls: 1, compacts: 1, cues: 1 });
  expect(h.askDialogOpts[0]).toEqual({ timeout: 10_000 });
});

test("a timed-out or escaped ask on a model switch defaults to sending as-is", async () => {
  const h = harness({
    branch: served([{ provider: "openai-codex", model: "gpt-6.2-sol", ts: now.t - 60_000 }]),
    model: { provider: "opencode-go", id: "glm-5.3" },
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 0, askCalls: 1, compacts: 0, cues: 0 });
  expect(h.askTitles[0]).toContain("openai-codex/gpt-6.2-sol");
  expect(h.askDialogOpts[0]).toEqual({ timeout: 10_000 });
});

test("deep context with no warmth anywhere passes through ungated", async () => {
  const h = harness({
    branch: served([]),
    model: { provider: "opencode-go", id: "glm-5.3" },
  });
  await h.handlers["context_with_system"]({}, h.ctx);
  expect(h.counts()).toEqual({ aborts: 0, askCalls: 0, compacts: 0, cues: 0 });
});
