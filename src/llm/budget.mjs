import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';

const PRICES_FILE = path.join(ROOT, 'config', 'llm-prices.json');

export const DEFAULT_DAILY_BUDGET_INR = 200;

let pricesCache = null;

export function loadPrices({ file = PRICES_FILE, reload = false } = {}) {
  if (!pricesCache || reload) pricesCache = JSON.parse(readFileSync(file, 'utf8'));
  return pricesCache;
}

export function priceFor(model, prices = loadPrices()) {
  const row = (prices.models || {})[model];
  if (row) return { ...row, model, priced: true };
  return { ...prices.fallback, model, priced: false };
}

/**
 * Cost of one call in INR, from the token counts the provider reported.
 *
 * Rounded up to four decimal places (0.0001 INR) so a run of very cheap calls
 * can never accumulate to zero. Under-counting spend is the only error here
 * that can breach a cap, so the arithmetic rounds against us, never for us.
 */
export function costInr({ model, inputTokens = 0, outputTokens = 0 }, prices = loadPrices()) {
  const p = priceFor(model, prices);
  const usd =
    (Number(inputTokens) / 1e6) * Number(p.inputUsdPerMillion) +
    (Number(outputTokens) / 1e6) * Number(p.outputUsdPerMillion);
  const inr = usd * Number(prices.rateInrPerUsd);
  return Math.ceil(inr * 10000) / 10000;
}

export function dailyBudgetInr(env = process.env) {
  const raw = env.LLM_DAILY_BUDGET_INR;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DAILY_BUDGET_INR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`LLM_DAILY_BUDGET_INR must be a non-negative number, got: ${raw}`);
  }
  return n;
}

/**
 * Per-day spend guard.
 *
 * Spend lives in the store, not in memory, so restarting the process - or
 * running the pipeline twice in one morning - resumes the same day's total
 * instead of handing the cap back. An estimate of the next call's cost is
 * checked BEFORE the call, because a cap that is only noticed afterwards is not
 * a cap.
 */
export function createBudget(store, { day, capInr = DEFAULT_DAILY_BUDGET_INR, prices = loadPrices() } = {}) {
  let spent = null;

  const load = async () => {
    if (spent === null) spent = Number(await store.llmSpend(day)) || 0;
    return spent;
  };

  return {
    day,
    capInr,

    async spent() {
      return load();
    },

    async remaining() {
      return Math.max(0, capInr - (await load()));
    },

    /** Would a call of roughly this shape fit? Returns { allowed, spent, cap, estimateInr }. */
    async check({ model, inputTokens = 0, outputTokens = 0 }) {
      const current = await load();
      const estimateInr = costInr({ model, inputTokens, outputTokens }, prices);
      return {
        allowed: current + estimateInr <= capInr,
        spent: current,
        cap: capInr,
        estimateInr,
        remaining: Math.max(0, capInr - current),
      };
    },

    /** Record what a call actually cost. Returns the new day total. */
    async record(amountInr) {
      const current = await load();
      const next = Math.round((current + Number(amountInr || 0)) * 10000) / 10000;
      await store.addLlmSpend(day, Number(amountInr || 0));
      spent = next;
      return next;
    },
  };
}
