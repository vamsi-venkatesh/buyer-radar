import { DIGEST } from '../config.mjs';
import { resolveProvider } from './client.mjs';
import { dailyBudgetInr } from './budget.mjs';

export const DEFAULT_ENRICH_LIMIT = 40;

function intFromEnv(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`${name} must be a non-negative whole number, got: ${raw}`);
  }
  return n;
}

/**
 * Whether the LLM stage runs at all, and with what.
 *
 * The switch is deliberately off-by-default in the one way that matters: with no
 * API key there is no stage, whatever LLM_ENABLED says. LLM_ENABLED=false turns
 * it off even when a key is sitting in the environment, which is the flag to
 * reach for when something looks wrong and the pipeline still has to run.
 */
export function llmSettings(env = process.env, { noLlm = false } = {}) {
  const provider = env.LLM_PROVIDER || 'deepseek';
  let resolved;
  try {
    resolved = resolveProvider(provider, env);
  } catch (err) {
    return { enabled: false, reason: err.message, provider, model: null };
  }

  const base = {
    provider,
    model: resolved.model,
    hasKey: Boolean(resolved.apiKey),
    enrichLimit: intFromEnv(env.LLM_ENRICH_LIMIT, DEFAULT_ENRICH_LIMIT, 'LLM_ENRICH_LIMIT'),
    openerTopN: intFromEnv(env.LLM_OPENER_TOP_N, DIGEST.topN, 'LLM_OPENER_TOP_N'),
    dailyBudgetInr: dailyBudgetInr(env),
    minConfidence: 0.7,
  };

  if (noLlm) return { ...base, enabled: false, reason: '--no-llm' };
  if (String(env.LLM_ENABLED).toLowerCase() === 'false') {
    return { ...base, enabled: false, reason: 'LLM_ENABLED=false' };
  }
  if (!resolved.apiKey) {
    return { ...base, enabled: false, reason: `no API key (${resolved.apiKeyEnv} is unset)` };
  }
  if (!resolved.model) return { ...base, enabled: false, reason: 'no model (LLM_MODEL is unset)' };
  if (!resolved.url) return { ...base, enabled: false, reason: 'no base URL' };
  return { ...base, enabled: true, reason: null };
}
