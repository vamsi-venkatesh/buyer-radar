import test from 'node:test';
import assert from 'node:assert/strict';

import { chat, LlmError, resolveProvider } from '../src/llm/client.mjs';
import { cacheKey, createCache, inputHash } from '../src/llm/cache.mjs';
import { createBudget, costInr, loadPrices, dailyBudgetInr } from '../src/llm/budget.mjs';
import { createRunner, enrichLeads, writeOpeners, selectForEnrichment, enrichUrl, parseOpener } from '../src/llm/stage.mjs';
import { parseEnrich, applyEnrichment, enrichInput } from '../src/llm/enrich.mjs';
import { htmlToText, parseRobots, robotsAllows, createPageFetcher, uaToken } from '../src/llm/page.mjs';
import { loadPrompt } from '../src/llm/prompts.mjs';
import { llmSettings } from '../src/llm/settings.mjs';
import { ReceiptChain } from '../src/lib/receipts.mjs';
import { scoreLead, modelInputs, effectiveSegment, describeSegment, toLead } from '../src/model.mjs';
import { renderDigest, digestOpener } from '../src/digest.mjs';
import { fixtureStore } from './fixtures/store.mjs';

// ---------------------------------------------------------------- stub fetch
//
// Every test in this file runs against one of these. Nothing here can reach a
// real endpoint: there is no code path in the suite that uses global fetch.

const ENV = { DEEPSEEK_API_KEY: 'test-key-not-a-real-one', LLM_MODEL: 'deepseek-chat' };
const DAY = '2026-09-11';

function textResponse(body, { status = 200, contentType = 'application/json', url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function completion(content, { promptTokens = 100, completionTokens = 50, model = 'deepseek-chat' } = {}) {
  return textResponse({
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

/** A fetch stub that answers from a queue of replies and records every call. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {} });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  impl.calls = calls;
  return impl;
}

const GOOD_ENRICH = JSON.stringify({
  segment: 'hotel',
  size: 'large',
  buys: ['vegetables', 'peeled garlic'],
  quantity: '400 covers a day',
  deadline: null,
  evidence: ['We run 120 rooms and two restaurants in Bengaluru.'],
  confidence: 0.86,
});

function settingsFor(over = {}) {
  return { ...llmSettings(ENV), ...over };
}

function leadWith(over = {}) {
  const { llm, ...rest } = over;
  const lead = toLead(
    {
      kind: 'buyer',
      segment: 'restaurant',
      name: 'Empire Kitchen',
      city: 'Bengaluru',
      state: 'Karnataka',
      website: 'https://example.com/about',
      source: 'overpass',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      externalId: 'node/1',
      ...rest,
    },
    { nowIso: '2026-09-11T06:00:00.000Z' }
  );
  if (llm) lead.extra = { ...lead.extra, llm };
  return lead;
}

// ---------------------------------------------------------------- the client

test('the client posts an OpenAI-shaped body to the configured provider', async () => {
  const fetchImpl = stubFetch([completion('hello')]);
  const res = await chat(
    { provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, jsonMode: true },
    { fetchImpl, env: ENV }
  );
  assert.equal(res.text, 'hello');
  assert.equal(res.inputTokens, 100);
  assert.equal(res.outputTokens, 50);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetchImpl.calls[0].body.temperature, 0);
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer test-key-not-a-real-one');
});

test('the client retries once on 429 and then succeeds', async () => {
  const fetchImpl = stubFetch([textResponse('rate limited', { status: 429 }), completion('second time')]);
  const res = await chat(
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl, env: ENV, sleep: async () => {}, backoffMs: 0 }
  );
  assert.equal(res.text, 'second time');
  assert.equal(res.retried, true);
  assert.equal(fetchImpl.calls.length, 2, 'exactly one retry, not a loop');
});

test('the client retries a 503 but never a 401', async () => {
  const on503 = stubFetch([textResponse('upstream down', { status: 503 }), completion('recovered')]);
  await chat({ messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: on503, env: ENV, sleep: async () => {}, backoffMs: 0 });
  assert.equal(on503.calls.length, 2);

  const on401 = stubFetch([textResponse('unauthorised', { status: 401 })]);
  await assert.rejects(
    () => chat({ messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: on401, env: ENV, sleep: async () => {}, backoffMs: 0 }),
    (err) => err instanceof LlmError && err.status === 401 && err.retriable === false
  );
  assert.equal(on401.calls.length, 1, 'a bad key is never retried');
});

test('the client refuses to call with no key, no model or no base URL', async () => {
  const fetchImpl = stubFetch([completion('never')]);
  await assert.rejects(
    () => chat({ messages: [{ role: 'user', content: 'x' }] }, { fetchImpl, env: { LLM_MODEL: 'deepseek-chat' } }),
    /no API key/
  );
  await assert.rejects(
    () => chat({ provider: 'openai-compatible', messages: [{ role: 'user', content: 'x' }] }, { fetchImpl, env: { LLM_API_KEY: 'k' } }),
    /no base URL/
  );
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent when the configuration is incomplete');
});

test('the openai-compatible provider reads its endpoint from the environment', () => {
  const r = resolveProvider('openai-compatible', { LLM_BASE_URL: 'https://llm.example.internal/v1/', LLM_API_KEY: 'k', LLM_MODEL: 'local-1' });
  assert.equal(r.url, 'https://llm.example.internal/v1/chat/completions');
  assert.equal(r.model, 'local-1');
});

// ---------------------------------------------------------------- the cache

test('the cache key changes with the prompt version, the model and the input', () => {
  const base = { provider: 'deepseek', model: 'deepseek-chat', promptVersion: 'enrich/v1', input: 'page text' };
  const same = cacheKey(base);
  assert.equal(same, cacheKey({ ...base }), 'the same question always hashes the same');
  assert.notEqual(same, cacheKey({ ...base, promptVersion: 'enrich/v2' }), 'a new prompt version is a new question');
  assert.notEqual(same, cacheKey({ ...base, model: 'deepseek-reasoner' }));
  assert.notEqual(same, cacheKey({ ...base, provider: 'openai-compatible' }));
  assert.notEqual(same, cacheKey({ ...base, input: 'page text.' }));
  assert.match(same, /^[0-9a-f]{64}$/);
});

test('a cache miss calls the model, a cache hit does not and costs nothing', async () => {
  const store = fixtureStore();
  const fetchImpl = stubFetch([completion(GOOD_ENRICH)]);
  const chain = new ReceiptChain('run_test');
  const runner = createRunner({ store, chain, settings: settingsFor(), day: DAY, fetchImpl, env: ENV });
  const prompt = loadPrompt('enrich');

  const first = await runner.ask({ purpose: 'enrich', prompt, input: 'some page text', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(first.ok, true);
  assert.equal(first.cacheHit, false);
  assert.equal(fetchImpl.calls.length, 1);

  const second = await runner.ask({ purpose: 'enrich', prompt, input: 'some page text', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(second.ok, true);
  assert.equal(second.cacheHit, true);
  assert.equal(fetchImpl.calls.length, 1, 'the second ask sent nothing');
  assert.deepEqual(second.value, first.value);

  const totals = runner.totals();
  assert.equal(totals.calls, 1);
  assert.equal(totals.cacheHits, 1);

  const hit = chain.receipts.find((r) => r.type === 'llm.cache_hit');
  assert.equal(hit.costInr, 0, 'a cache hit costs nothing and says so');
  assert.equal(hit.cacheHit, true);
});

test('changing the prompt version misses a cache that was warm for the old one', async () => {
  const store = fixtureStore();
  const cache = createCache(store);
  const parts = { provider: 'deepseek', model: 'deepseek-chat', promptVersion: 'enrich/v1', input: 'text' };
  await cache.put(parts, 'cached answer');
  assert.equal((await cache.get(parts)).hit, true);
  assert.equal((await cache.get({ ...parts, promptVersion: 'enrich/v2' })).hit, false);
});

// ---------------------------------------------------------------- the budget

test('cost is computed from the published price table and rounded against us', () => {
  const prices = loadPrices();
  const c = costInr({ model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 1_000_000 }, prices);
  const expected = (prices.models['deepseek-chat'].inputUsdPerMillion + prices.models['deepseek-chat'].outputUsdPerMillion) * prices.rateInrPerUsd;
  assert.equal(c, Math.ceil(expected * 10000) / 10000);
  const tiny = costInr({ model: 'deepseek-chat', inputTokens: 1, outputTokens: 0 }, prices);
  assert.ok(tiny > 0, 'a very cheap call never rounds to free');
  const unknown = costInr({ model: 'not-in-the-table', inputTokens: 1_000_000, outputTokens: 0 }, prices);
  assert.ok(unknown > costInr({ model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 0 }, prices), 'an unpriced model is charged pessimistically');
});

test('LLM_DAILY_BUDGET_INR defaults to 200 and refuses nonsense', () => {
  assert.equal(dailyBudgetInr({}), 200);
  assert.equal(dailyBudgetInr({ LLM_DAILY_BUDGET_INR: '25' }), 25);
  assert.throws(() => dailyBudgetInr({ LLM_DAILY_BUDGET_INR: 'plenty' }), /non-negative/);
  assert.throws(() => dailyBudgetInr({ LLM_DAILY_BUDGET_INR: '-1' }), /non-negative/);
});

test('the budget cap stops calls and survives a restart', async () => {
  // One expensive call fits under the cap; the next one does not.
  const llmCache = new Map();
  const llmSpend = new Map();
  const store = fixtureStore({ llmCache, llmSpend });
  const expensive = () => completion(GOOD_ENRICH, { promptTokens: 200_000, completionTokens: 50_000 });
  const perCall = costInr({ model: 'deepseek-chat', inputTokens: 200_000, outputTokens: 50_000 });
  const fetchImpl = stubFetch([expensive()]);
  const chain = new ReceiptChain('run_budget');
  const settings = settingsFor({ dailyBudgetInr: perCall });
  const runner = createRunner({ store, chain, settings, day: DAY, fetchImpl, env: ENV });
  const prompt = loadPrompt('enrich');

  const first = await runner.ask({ purpose: 'enrich', prompt, input: 'page one', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(first.ok, true);
  assert.equal(await store.llmSpend(DAY), perCall, 'the spend is persisted, not held in memory');

  const second = await runner.ask({ purpose: 'enrich', prompt, input: 'page two', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'budget');
  assert.equal(fetchImpl.calls.length, 1, 'the second call was never sent');

  const skip = chain.receipts.find((r) => r.type === 'llm.budget_exhausted');
  assert.equal(skip.day, DAY);
  assert.equal(skip.capInr, perCall);
  assert.ok(skip.spentInr > 0);

  // "Restart": a brand new runner over the same stored spend.
  const restarted = createRunner({
    store: fixtureStore({ llmCache, llmSpend }),
    chain: new ReceiptChain('run_after_restart'),
    settings,
    day: DAY,
    fetchImpl,
    env: ENV,
  });
  const afterRestart = await restarted.ask({ purpose: 'enrich', prompt, input: 'page three', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(afterRestart.reason, 'budget', 'a restart does not hand the cap back');
  assert.equal(fetchImpl.calls.length, 1);
});

test('a new day starts with a fresh cap', async () => {
  const llmSpend = new Map([['2026-09-11', 500]]);
  const store = fixtureStore({ llmSpend });
  const yesterday = createBudget(store, { day: '2026-09-11', capInr: 200 });
  const today = createBudget(store, { day: '2026-09-12', capInr: 200 });
  assert.equal((await yesterday.check({ model: 'deepseek-chat', inputTokens: 10, outputTokens: 10 })).allowed, false);
  assert.equal((await today.check({ model: 'deepseek-chat', inputTokens: 10, outputTokens: 10 })).allowed, true);
});

// ---------------------------------------------------------------- receipts

test('an llm.call receipt carries every field the run summary is built from', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('run_receipts');
  const fetchImpl = stubFetch([completion(GOOD_ENRICH)]);
  const runner = createRunner({ store, chain, settings: settingsFor(), day: DAY, fetchImpl, env: ENV });
  await runner.ask({ purpose: 'enrich', prompt: loadPrompt('enrich'), input: 'page text', maxTokens: 600, jsonMode: true, parse: parseEnrich });

  const call = chain.receipts.find((r) => r.type === 'llm.call');
  assert.deepEqual(Object.keys(call).sort(), [
    'at', 'cacheHit', 'costInr', 'inputHash', 'inputTokens', 'model', 'ms',
    'outputTokens', 'promptVersion', 'provider', 'purpose', 'seq', 'type',
  ]);
  assert.equal(call.purpose, 'enrich');
  assert.equal(call.provider, 'deepseek');
  assert.equal(call.model, 'deepseek-chat');
  assert.equal(call.promptVersion, loadPrompt('enrich').version);
  assert.equal(call.inputHash, inputHash('page text'));
  assert.equal(call.inputTokens, 100);
  assert.equal(call.outputTokens, 50);
  assert.equal(call.cacheHit, false);
  assert.ok(call.costInr > 0);
  assert.equal(typeof call.ms, 'number');
  assert.ok(!JSON.stringify(chain.receipts).includes('test-key-not-a-real-one'), 'no receipt ever carries the key');
});

// ---------------------------------------------------------------- the answer

test('a malformed reply is repaired once, and a second bad reply is recorded, not used', async () => {
  const prompt = loadPrompt('enrich');

  const repaired = stubFetch([completion('Sure! Here you go:\n```json\n{bad json,,}\n```'), completion(GOOD_ENRICH)]);
  const chainA = new ReceiptChain('run_repair');
  const runnerA = createRunner({ store: fixtureStore(), chain: chainA, settings: settingsFor(), day: DAY, fetchImpl: repaired, env: ENV });
  const a = await runnerA.ask({ purpose: 'enrich', prompt, input: 'x', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(a.ok, true);
  assert.equal(a.repaired, true);
  assert.equal(repaired.calls.length, 2);
  assert.equal(repaired.calls[1].body.messages.length, 4, 'the repair shows the model its own bad reply');

  const hopeless = stubFetch([completion('not json at all')]);
  const chainB = new ReceiptChain('run_invalid');
  const runnerB = createRunner({ store: fixtureStore(), chain: chainB, settings: settingsFor(), day: DAY, fetchImpl: hopeless, env: ENV });
  const b = await runnerB.ask({ purpose: 'enrich', prompt, input: 'x', maxTokens: 600, jsonMode: true, parse: parseEnrich });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'invalid');
  assert.equal(hopeless.calls.length, 2, 'one repair attempt, then it stops asking');
  const receipt = chainB.receipts.find((r) => r.type === 'llm.invalid_output');
  assert.equal(receipt.repairAttempted, true);
  assert.equal(receipt.purpose, 'enrich');
  assert.ok(receipt.reason);
});

test('the answer reader accepts a fenced object and refuses an invented segment', () => {
  const fenced = parseEnrich('```json\n' + GOOD_ENRICH + '\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.segment, 'hotel');

  assert.equal(parseEnrich(JSON.stringify({ segment: 'ghost kitchen', size: 'large', confidence: 0.9 })).ok, false);
  assert.equal(parseEnrich(JSON.stringify({ segment: 'hotel', size: 'enormous', confidence: 0.9 })).ok, false);
  assert.equal(parseEnrich(JSON.stringify({ segment: 'hotel', size: 'large' })).ok, false, 'a missing confidence is a missing answer');
});

test('out-of-range values are clamped down, and a non-date deadline is dropped', () => {
  const parsed = parseEnrich(
    JSON.stringify({ segment: 'hotel', size: 'large', confidence: 1.7, deadline: 'next month', evidence: ['x'.repeat(300)], buys: ['a', 2, 'b'] })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.confidence, 1, 'confidence can only be clamped downwards');
  assert.equal(parsed.value.deadline, null);
  assert.equal(parsed.value.deadlineDropped, 'next month');
  assert.equal(parsed.value.evidence[0].length, 120);
  assert.deepEqual(parsed.value.buys, ['a', 'b']);
  assert.equal(parseEnrich(JSON.stringify({ segment: 'hotel', size: 'large', confidence: 0.8, deadline: '2026-02-30' })).value.deadline, null);
});

test('applying an answer never overwrites the source-derived segment', () => {
  const lead = leadWith({ segment: 'restaurant' });
  applyEnrichment(lead, parseEnrich(GOOD_ENRICH).value, { promptVersion: 'enrich/v1', provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(lead.segment, 'restaurant', 'the register still records what the source said');
  assert.equal(lead.segment_source, 'restaurant');
  assert.equal(lead.segment_model, 'hotel');
  assert.equal(lead.extra.llm.confidence, 0.86);
  assert.deepEqual(lead.extra.llm.evidence, ['We run 120 rooms and two restaurants in Bengaluru.']);
});

// ---------------------------------------------------------------- the page

test('html is stripped to the text a reader would see', () => {
  const html = `
    <html><head><title>T</title><style>.a{color:red}</style><script>var x = "<p>not text</p>";</script></head>
    <body><!-- a comment -->
      <h1>Sri Lakshmi Vegetables</h1>
      <p>Wholesale supplier &amp; distributor, Bengaluru.</p>
      <ul><li>Onion</li><li>Garlic</li></ul>
      <div>Rs&nbsp;1,200 per quintal</div>
    </body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('Sri Lakshmi Vegetables'));
  assert.ok(text.includes('Wholesale supplier & distributor, Bengaluru.'));
  assert.ok(text.includes('Onion'));
  assert.ok(!text.includes('color:red'), 'style is not text');
  assert.ok(!text.includes('var x'), 'script is not text');
  assert.ok(!text.includes('not text'), 'markup inside a script is not text either');
  assert.ok(!text.includes('<'), 'no tags survive');
});

test('page text is capped at 6,000 characters', () => {
  const text = htmlToText(`<p>${'word '.repeat(4000)}</p>`);
  assert.ok(text.length <= 6000);
});

test('robots.txt is parsed per agent and the longest match wins', () => {
  const robots = parseRobots(
    ['User-agent: *', 'Disallow: /private', 'Allow: /private/public-menu', '', 'User-agent: SomeoneElse', 'Disallow: /'].join('\n'),
    'buyerradar'
  );
  assert.equal(robots.matched, '*', 'with no group of our own we obey the star group');
  assert.equal(robotsAllows(robots, '/about'), true);
  assert.equal(robotsAllows(robots, '/private/prices'), false);
  assert.equal(robotsAllows(robots, '/private/public-menu'), true, 'a longer Allow beats a shorter Disallow');

  const named = parseRobots(['User-agent: buyerradar', 'Disallow: /', '', 'User-agent: *', 'Disallow:'].join('\n'), 'buyerradar');
  assert.equal(named.matched, 'buyerradar');
  assert.equal(robotsAllows(named, '/anything'), false, 'a group naming us wins over the star group');

  assert.equal(uaToken('BuyerRadar/0.1 (radar@example.com)'), 'buyerradar');
});

test('a disallowed page is never fetched and the reason is reported', async () => {
  const fetchImpl = stubFetch([
    (url) =>
      String(url).endsWith('/robots.txt')
        ? textResponse('User-agent: *\nDisallow: /private\n', { contentType: 'text/plain' })
        : textResponse('<p>Secret</p>', { contentType: 'text/html' }),
  ]);
  const pages = createPageFetcher({ fetchImpl, sleep: async () => {} });

  const blocked = await pages.fetchText('https://example.com/private/rates');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /robots\.txt disallows/);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['https://example.com/robots.txt'], 'only robots.txt was ever requested');

  const allowed = await pages.fetchText('https://example.com/about');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.text, 'Secret');
  assert.equal(fetchImpl.calls.length, 2, 'robots.txt is read once per host, not once per page');
});

test('a non-html content type and a failed request are refusals, not empty pages', async () => {
  const pdf = stubFetch([
    (url) => (String(url).endsWith('/robots.txt') ? textResponse('', { status: 404, contentType: 'text/plain' }) : textResponse('%PDF-1.4', { contentType: 'application/pdf' })),
  ]);
  const a = await createPageFetcher({ fetchImpl: pdf, sleep: async () => {} }).fetchText('https://example.com/menu.pdf');
  assert.equal(a.ok, false);
  assert.match(a.reason, /content-type application\/pdf/);

  const gone = stubFetch([
    (url) => (String(url).endsWith('/robots.txt') ? textResponse('', { status: 404, contentType: 'text/plain' }) : textResponse('nope', { status: 404, contentType: 'text/html' })),
  ]);
  const b = await createPageFetcher({ fetchImpl: gone, sleep: async () => {} }).fetchText('https://example.com/gone');
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'HTTP 404');
});

// ---------------------------------------------------------------- scoring

test('scoring prefers the model segment only at confidence 0.7 or above', () => {
  const base = { city: 'Bengaluru', todayIsoDate: '2026-09-11' };
  const plain = leadWith({ segment: 'other' });
  const below = leadWith({ segment: 'other', llm: { segment: 'wholesale', size: 'unknown', confidence: 0.69, deadline: null } });
  const at = leadWith({ segment: 'other', llm: { segment: 'wholesale', size: 'unknown', confidence: 0.7, deadline: null } });

  assert.equal(effectiveSegment(below), 'other');
  assert.equal(effectiveSegment(at), 'wholesale');
  assert.equal(modelInputs(below), null);

  assert.equal(scoreLead(below, base).parts.segment, scoreLead(plain, base).parts.segment, 'a low-confidence answer moves nothing');
  assert.equal(scoreLead(below, base).inputs.segmentFrom, 'source');
  assert.equal(scoreLead(at, base).parts.segment, 30);
  assert.equal(scoreLead(at, base).inputs.segmentFrom, 'model');
  assert.ok(scoreLead(at, base).score > scoreLead(below, base).score);
});

test('size moves the segment band and never lifts it past 30', () => {
  const base = { city: 'Bengaluru', todayIsoDate: '2026-09-11' };
  const large = leadWith({ segment: 'institution', llm: { segment: 'institution', size: 'large', confidence: 0.9, deadline: null } });
  const small = leadWith({ segment: 'institution', llm: { segment: 'institution', size: 'small', confidence: 0.9, deadline: null } });
  const unknown = leadWith({ segment: 'institution', llm: { segment: 'institution', size: 'unknown', confidence: 0.9, deadline: null } });
  assert.equal(scoreLead(unknown, base).parts.segment, 16);
  assert.equal(scoreLead(large, base).parts.segment, 22);
  assert.equal(scoreLead(small, base).parts.segment, 12);

  const bigHotel = leadWith({ segment: 'hotel', llm: { segment: 'hotel', size: 'large', confidence: 0.9, deadline: null } });
  assert.equal(scoreLead(bigHotel, base).parts.segment, 30, 'the band stays at 30, so the total stays at 100');
  assert.ok(scoreLead(bigHotel, base).score <= 100);
});

test('a model deadline fills a missing date but never replaces one the source gave', () => {
  const base = { city: 'Bengaluru', todayIsoDate: '2026-09-11' };
  const noDate = leadWith({ llm: { segment: 'institution', size: 'unknown', confidence: 0.9, deadline: '2026-09-20' } });
  assert.equal(scoreLead(noDate, base).parts.recency, 20, 'a deadline nine days out is a fresh reason to call');

  const sourceDated = leadWith({ whyNow: 'reported 2026-06-01', whyNowDate: '2026-06-01', llm: { segment: 'institution', size: 'unknown', confidence: 0.9, deadline: '2026-09-20' } });
  assert.equal(scoreLead(sourceDated, base).parts.recency, 0, "the source's own date still decides");
});

// ---------------------------------------------------------------- the stage

test('enrichment reads a page, writes a second opinion and receipts it', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('run_enrich');
  const fetchImpl = stubFetch([
    (url) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return textResponse('', { status: 404, contentType: 'text/plain' });
      if (u.includes('api.deepseek.com')) return completion(GOOD_ENRICH);
      return textResponse('<h1>Hotel Sunrise</h1><p>120 rooms and two restaurants in Bengaluru.</p>', { contentType: 'text/html' });
    },
  ]);
  const settings = settingsFor();
  const runner = createRunner({ store, chain, settings, day: DAY, fetchImpl, env: ENV });
  // segment 'other' is what makes the call needed at all - see "Model only when
  // needed" in the README. A lead the source already segmented is skipped.
  const leads = [leadWith({ name: 'Hotel Sunrise', segment: 'other', website: 'https://sunrise.example/about' })];
  const out = await enrichLeads(leads, {
    runner,
    chain,
    settings,
    pageFetcher: createPageFetcher({ fetchImpl, sleep: async () => {} }),
  });

  assert.equal(out.enriched, 1);
  assert.equal(out.pagesRead, 1);
  assert.equal(leads[0].segment_model, 'hotel');
  assert.equal(leads[0].segment, 'other', 'the source-derived segment is never overwritten');
  const receipt = chain.receipts.find((r) => r.type === 'llm.enriched');
  assert.equal(receipt.segmentSource, 'other');
  assert.equal(receipt.segmentModel, 'hotel');
  assert.equal(receipt.confidence, 0.86);
});

test('two leads sharing one website share one cached answer, an article does not', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('run_shared');
  const fetchImpl = stubFetch([
    (url) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return textResponse('', { status: 404, contentType: 'text/plain' });
      if (u.includes('api.deepseek.com')) return completion(GOOD_ENRICH);
      return textResponse('<h1>Coastal Bowl</h1><p>22 restaurants, one central kitchen.</p>', { contentType: 'text/html' });
    },
  ]);
  const settings = settingsFor();
  const runner = createRunner({ store, chain, settings, day: DAY, fetchImpl, env: ENV });
  const pageFetcher = createPageFetcher({ fetchImpl, sleep: async () => {} });
  const outlets = [
    leadWith({ externalId: 'node/1', name: 'Coastal Bowl Indiranagar', segment: 'other', website: 'https://coastalbowl.example/' }),
    leadWith({ externalId: 'node/2', name: 'Coastal Bowl HSR', segment: 'other', website: 'https://coastalbowl.example/' }),
  ];
  await enrichLeads(outlets, { runner, chain, settings, pageFetcher });
  assert.equal(runner.totals().calls, 1);
  assert.equal(runner.totals().cacheHits, 1, 'the second outlet reads the first outlet is answer');
  assert.equal(outlets[1].segment_model, 'hotel');
});

test('the digest and the register call a lead what the score called it', () => {
  const tender = leadWith({
    segment: 'hotel',
    name: 'Hostel mess vegetable tender',
    llm: { segment: 'institution', size: 'large', confidence: 0.85, deadline: '2026-09-24' },
  });
  assert.equal(tender.segment, 'hotel', 'the source-derived value is still on the record');
  assert.equal(describeSegment(tender), 'institution');

  const unsure = leadWith({ segment: 'hotel', llm: { segment: 'institution', size: 'large', confidence: 0.4, deadline: null } });
  assert.equal(describeSegment(unsure), 'hotel', 'a low-confidence reading changes no label either');
});

test('a lead with nothing to read is never sent to the model', async () => {
  const prompt = loadPrompt('enrich');
  const mapOnly = leadWith({ website: null });
  assert.equal(enrichUrl(mapOnly), null, 'a map listing is not a page about the business');
  const article = leadWith({ website: null, source: 'news', sourceUrl: 'https://news.example/story' });
  assert.equal(enrichUrl(article), 'https://news.example/story');

  const chosen = selectForEnrichment([mapOnly, article], { limit: 40, promptVersion: prompt.version });
  assert.deepEqual(chosen.map((l) => l.id), [article.id]);
});

test('selection respects the limit, takes the best scores first and skips what is already enriched', () => {
  const prompt = loadPrompt('enrich');
  const leads = Array.from({ length: 10 }, (_, i) =>
    leadWith({ externalId: `node/${i}`, website: `https://example.com/${i}` , score: i })
  ).map((l, i) => Object.assign(l, { score: i }));
  leads[9].extra = { ...leads[9].extra, llm: { promptVersion: prompt.version, confidence: 0.9 } };

  const chosen = selectForEnrichment(leads, { limit: 3, promptVersion: prompt.version });
  assert.equal(chosen.length, 3);
  assert.deepEqual(chosen.map((l) => l.score), [8, 7, 6], 'the already-enriched top lead is skipped, then best score first');
});

test('the budget cap stops enrichment rather than skipping one lead and carrying on', async () => {
  const store = fixtureStore({ llmSpend: new Map([[DAY, 1000]]) });
  const chain = new ReceiptChain('run_stop');
  const fetchImpl = stubFetch([
    (url) =>
      String(url).endsWith('/robots.txt')
        ? textResponse('', { status: 404, contentType: 'text/plain' })
        : textResponse('<p>A business page.</p>', { contentType: 'text/html' }),
  ]);
  const settings = settingsFor({ dailyBudgetInr: 200 });
  const runner = createRunner({ store, chain, settings, day: DAY, fetchImpl, env: ENV });
  const leads = [
    leadWith({ externalId: 'node/1', segment: 'other', website: 'https://a.example/' }),
    leadWith({ externalId: 'node/2', segment: 'other', website: 'https://b.example/' }),
  ];
  const out = await enrichLeads(leads, { runner, chain, settings, pageFetcher: createPageFetcher({ fetchImpl, sleep: async () => {} }) });
  assert.equal(out.enriched, 0);
  assert.equal(out.stopped, 'budget');
  assert.equal(chain.receipts.filter((r) => r.type === 'llm.budget_exhausted').length, 1, 'it stops at the first refusal instead of asking again per lead');
  assert.equal(runner.totals().calls, 0);
});

// ---------------------------------------------------------------- openers

test('an opener is two plain lines, and hype or an emoji is refused', () => {
  const good = parseOpener('Saw you run three outlets in Jayanagar.\nWe supply peeled garlic in Bengaluru - can I send rates?');
  assert.equal(good.ok, true);
  assert.equal(good.value.split('\n').length, 2);

  assert.equal(parseOpener('Only one line here.').ok, false);
  assert.equal(parseOpener('We are thrilled to partner with you.\nBest rates in town.').ok, false);
  assert.equal(parseOpener('Hello there.\nFresh veg daily 🥦').ok, false);
  assert.equal(parseOpener(`${'x'.repeat(130)}\nsecond line`).ok, false);
  assert.equal(parseOpener('"Quoted line one."\n"Quoted line two."').value.startsWith('Quoted line one'), true);
});

test('openers are written only for the leads the digest shows', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('run_openers');
  const fetchImpl = stubFetch([completion('Saw you buy vegetables daily for two kitchens.\nWe supply peeled garlic in Bengaluru - can I send rates?')]);
  const settings = settingsFor({ openerTopN: 1 });
  const runner = createRunner({ store, chain, settings, day: DAY, fetchImpl, env: ENV });
  // Both carry a concrete fact, so the only thing separating them is whether
  // the digest shows them - see "Model only when needed" in the README.
  const fact = { llm: { evidence: ['We buy vegetables daily for two kitchens.'], confidence: 0.9 } };
  const shown = leadWith({ externalId: 'node/1', ...fact });
  const unseen = leadWith({ externalId: 'node/2', ...fact });

  const out = await writeOpeners([shown, unseen], { L1: shown.id }, { runner, chain, settings });
  assert.equal(out.written, 1);
  assert.equal(fetchImpl.calls.length, 1, 'a lead nobody will read today gets no call');
  assert.ok(shown.opener_model.includes('peeled garlic'));
  assert.equal(unseen.opener_model, null);
});

test('the digest uses the model opener when there is one, and the rule line otherwise', () => {
  const withModel = leadWith({ externalId: 'node/1', name: 'Hotel Sunrise', phone: '+919845000001' });
  withModel.opener_model = 'Saw you opened a second kitchen last month.\nWe supply peeled garlic daily - can I send rates?';
  withModel.status = 'new';
  const without = leadWith({ externalId: 'node/2', name: 'Copper Chimney', phone: '+919845000002' });
  without.status = 'new';

  assert.equal(digestOpener(withModel), withModel.opener_model);
  assert.equal(digestOpener(without), 'Daily peeled garlic, broccoli, capsicum.');

  const digest = renderDigest([withModel, without], { date: '2026-09-11', city: 'Bengaluru' });
  assert.ok(digest.text.includes('Saw you opened a second kitchen last month.'));
  assert.ok(digest.text.includes('Daily peeled garlic, broccoli, capsicum.'));
  assert.equal(digest.layout, 'model');
});

test('a digest with no model opener renders exactly as it did before the stage existed', () => {
  const a = leadWith({ externalId: 'node/1', name: 'Copper Chimney', phone: '+919845000001' });
  a.status = 'new';
  const digest = renderDigest([a], { date: '2026-09-11', city: 'Bengaluru' });
  assert.ok(digest.text.includes('"Daily peeled garlic, broccoli, capsicum."'));
});

// ---------------------------------------------------------------- the switch

test('the stage is off with no key, off when told to be off, and off for --no-llm', () => {
  const off = llmSettings({});
  assert.equal(off.enabled, false);
  assert.match(off.reason, /no API key/);

  const disabled = llmSettings({ ...ENV, LLM_ENABLED: 'false' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, 'LLM_ENABLED=false');

  const flagged = llmSettings(ENV, { noLlm: true });
  assert.equal(flagged.enabled, false);
  assert.equal(flagged.reason, '--no-llm');

  const on = llmSettings(ENV);
  assert.equal(on.enabled, true);
  assert.equal(on.provider, 'deepseek');
  assert.equal(on.model, 'deepseek-chat');
  assert.equal(on.enrichLimit, 40);
  assert.equal(on.dailyBudgetInr, 200);
});

test('LLM_ENABLED=true cannot turn the stage on without a key', () => {
  const s = llmSettings({ LLM_ENABLED: 'true' });
  assert.equal(s.enabled, false);
  assert.match(s.reason, /no API key/);
});

test('limits are read from the environment and nonsense is refused', () => {
  assert.equal(llmSettings({ ...ENV, LLM_ENRICH_LIMIT: '5' }).enrichLimit, 5);
  assert.equal(llmSettings({ ...ENV, LLM_OPENER_TOP_N: '3' }).openerTopN, 3);
  assert.throws(() => llmSettings({ ...ENV, LLM_ENRICH_LIMIT: 'lots' }), /whole number/);
});

test('the input the model reads is built the same way everywhere', () => {
  const input = enrichInput({ name: 'Hotel Sunrise', city: 'Bengaluru', url: 'https://sunrise.example/', text: '120 rooms.' });
  assert.ok(input.startsWith('Record name: Hotel Sunrise'));
  assert.ok(input.includes('Page text:\n120 rooms.'));
});

test('every prompt file carries a version', () => {
  for (const name of ['enrich', 'opener']) {
    const p = loadPrompt(name);
    assert.match(p.version, /^[a-z]+\/\d{4}-\d{2}-\d{2}[a-z]?$/);
    assert.ok(p.body.length > 200);
  }
});
