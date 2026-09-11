// Score the enrich prompt against the labelled synthetic pages.
//
//   node eval/llm/run.mjs                 # whichever lane the environment allows
//   node eval/llm/run.mjs --lane stub     # force the stub, spend nothing
//   node eval/llm/run.mjs --lane real     # force the provider, refuse if no key
//   node eval/llm/run.mjs --limit 5
//
// With a key in the environment this calls the real provider and the run costs
// real money, bounded by the same daily budget the pipeline uses. Without one it
// runs the keyword stub, and the summary says so in its first line - a stub
// result is never to be quoted as a measurement of the model.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, SYNTHETIC } from './fixtures.mjs';
import { stubEnrich } from './stub-model.mjs';
import { scoreCases, toMarkdown } from '../lib/score.mjs';
import { createRunner } from '../../src/llm/stage.mjs';
import { enrichInput, parseEnrich } from '../../src/llm/enrich.mjs';
import { loadPrompt } from '../../src/llm/prompts.mjs';
import { llmSettings } from '../../src/llm/settings.mjs';
import { htmlToText } from '../../src/llm/page.mjs';
import { ReceiptChain } from '../../src/lib/receipts.mjs';
import { todayIso } from '../../src/lib/normalise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const FIELDS = ['segment', 'size', 'deadline'];

/** The eval keeps its own throwaway store: an eval must never warm the pipeline's cache. */
function memoryStore() {
  const cache = new Map();
  const spend = new Map();
  return {
    async getLlmCache(key) { return cache.get(key) || null; },
    async putLlmCache(row) { cache.set(row.key, row); },
    async llmSpend(day) { return Number(spend.get(day) || 0); },
    async addLlmSpend(day, amount) {
      const next = Math.round((Number(spend.get(day) || 0) + Number(amount || 0)) * 10000) / 10000;
      spend.set(day, next);
      return next;
    },
  };
}

/** A fetch that answers with the stub model, in the exact shape a provider would. */
function stubFetch() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const input = body.messages.filter((m) => m.role === 'user').pop().content;
    const content = stubEnrich(input);
    const promptTokens = Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      ok: true,
      status: 200,
      url: '',
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          model: 'stub-keyword-reader',
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(content.length / 4) },
        }),
    };
  };
}

function parseArgs(argv) {
  const out = { lane: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lane') out.lane = String(argv[++i] || '');
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (out.lane && !['stub', 'real'].includes(out.lane)) throw new Error('--lane must be stub or real');
  return out;
}

export async function runEval({ lane, limit, env = process.env } = {}) {
  const settings = llmSettings(env);
  const chosenLane = lane || (settings.enabled ? 'real' : 'stub');
  if (chosenLane === 'real' && !settings.enabled) {
    throw new Error(`the real lane needs a working provider: ${settings.reason}`);
  }

  const cases = limit ? CASES.slice(0, limit) : CASES;
  const prompt = loadPrompt('enrich');
  const day = todayIso();
  const chain = new ReceiptChain(`eval_${day}`);
  const laneSettings =
    chosenLane === 'stub'
      ? { ...settings, enabled: true, provider: 'deepseek', model: 'stub-keyword-reader', dailyBudgetInr: settings.dailyBudgetInr }
      : settings;
  const runner = createRunner({
    store: memoryStore(),
    chain,
    settings: laneSettings,
    day,
    fetchImpl: chosenLane === 'stub' ? stubFetch() : globalThis.fetch,
    env: chosenLane === 'stub' ? { ...env, DEEPSEEK_API_KEY: 'stub-lane-no-network' } : env,
  });

  const results = [];
  for (const c of cases) {
    const before = runner.totals();
    const input = enrichInput({ name: c.name, city: c.city, url: c.url, text: htmlToText(c.html) });
    const answer = await runner.ask({
      purpose: 'eval.enrich',
      prompt,
      input,
      maxTokens: 600,
      jsonMode: true,
      parse: parseEnrich,
    });
    const after = runner.totals();
    const call = [...chain.receipts].reverse().find((r) => r.type === 'llm.call');
    results.push({
      id: c.id,
      ok: answer.ok,
      reason: answer.ok ? null : answer.detail || answer.reason,
      value: answer.ok ? answer.value : null,
      cacheHit: Boolean(answer.cacheHit),
      inputTokens: answer.cacheHit ? 0 : call?.inputTokens || 0,
      outputTokens: answer.cacheHit ? 0 : call?.outputTokens || 0,
      costInr: Math.round((after.costInr - before.costInr) * 10000) / 10000,
      ms: answer.cacheHit ? 0 : call?.ms || 0,
    });
  }

  const summary = scoreCases({ cases, results, fields: FIELDS });
  const meta = {
    title: 'Buyer Radar - enrich prompt evaluation',
    date: day,
    lane: chosenLane,
    laneNote:
      chosenLane === 'stub'
        ? 'no API key was present, so a keyword reader stood in for the model. These numbers measure the harness and the floor, NOT the model, and the cost below is notional - nothing was spent and no request left the machine.'
        : 'real calls to the configured provider, paid for out of the same daily budget the pipeline uses.',
    provider: laneSettings.provider,
    model: laneSettings.model,
    promptVersion: prompt.version,
    note: SYNTHETIC
      ? 'All 30 cases are synthetic pages written for this harness (eval/llm/fixtures.mjs). No business, tonnage, tender number or date in them is real, and none of it may be shown as data.'
      : null,
  };
  return { summary, meta, results, totals: runner.totals(), receipts: chain.receipts };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { summary, meta, results, totals } = await runEval(opts);
  await mkdir(RESULTS_DIR, { recursive: true });
  const stem = path.join(RESULTS_DIR, `${meta.date}.${meta.lane}`);
  await writeFile(`${stem}.json`, `${JSON.stringify({ meta, summary, results, totals }, null, 2)}\n`, 'utf8');
  const md = toMarkdown(summary, meta);
  await writeFile(`${stem}.md`, md, 'utf8');
  process.stdout.write(`${md}\n`);
  process.stderr.write(`written: ${path.relative(process.cwd(), stem)}.json and .md\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
