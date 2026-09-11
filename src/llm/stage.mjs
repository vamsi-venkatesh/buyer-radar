// The LLM stage: cache, budget, call, repair, receipt - in that order, every
// time. Nothing in this file decides a score, finds a lead or sends a message.
// It turns text into text and writes down exactly what that cost.

import { chat, LlmError } from './client.mjs';
import { createCache, inputHash } from './cache.mjs';
import { createBudget, costInr, loadPrices } from './budget.mjs';
import { loadPrompt } from './prompts.mjs';
import { enrichInput, parseEnrich, applyEnrichment, repairMessage } from './enrich.mjs';
import { createPageFetcher } from './page.mjs';
import { opener as ruleOpener, describeSegment } from '../model.mjs';
import { needsModel, digestCutoffs, cutoffFor } from './needs.mjs';
import { BUSINESS } from '../config.mjs';

const NO_CHAIN = { add() {} };

export const ENRICH_MAX_TOKENS = 600;
export const OPENER_MAX_TOKENS = 160;

/** Rough token estimate for the pre-call budget check. Deliberately generous. */
function estimateInputTokens(messages) {
  return Math.ceil(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 4) + 16;
}

/**
 * One runner per pipeline run. It holds the cache, the day's budget and the
 * running totals, so the run summary and the receipts describe the same calls.
 */
export function createRunner({
  store,
  chain = NO_CHAIN,
  settings,
  day,
  fetchImpl = globalThis.fetch,
  env = process.env,
  prices = loadPrices(),
  now = () => new Date().toISOString(),
  sleep,
}) {
  const cache = createCache(store);
  const budget = createBudget(store, { day, capInr: settings.dailyBudgetInr, prices });
  const totals = { calls: 0, cacheHits: 0, costInr: 0, budgetSkipped: 0, invalid: 0, errors: 0, notNeeded: 0 };

  async function callModel({ purpose, promptVersion, messages, maxTokens, jsonMode, key }) {
    const estimate = { model: settings.model, inputTokens: estimateInputTokens(messages), outputTokens: maxTokens };
    const check = await budget.check(estimate);
    if (!check.allowed) {
      totals.budgetSkipped += 1;
      chain.add('llm.budget_exhausted', {
        purpose,
        day,
        spentInr: round(check.spent),
        capInr: check.cap,
        estimateInr: check.estimateInr,
        inputHash: key,
      });
      return { ok: false, reason: 'budget' };
    }

    let res;
    try {
      res = await chat(
        { provider: settings.provider, model: settings.model, messages, maxTokens, temperature: 0, jsonMode },
        { fetchImpl, env, sleep }
      );
    } catch (err) {
      totals.errors += 1;
      chain.add('llm.error', {
        purpose,
        provider: settings.provider,
        model: settings.model,
        promptVersion,
        inputHash: key,
        status: err instanceof LlmError ? err.status : null,
        reason: err.message,
      });
      return { ok: false, reason: 'error', error: err };
    }

    const cost = costInr({ model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens }, prices);
    await budget.record(cost);
    totals.calls += 1;
    totals.costInr = round(totals.costInr + cost);
    chain.add('llm.call', {
      purpose,
      provider: settings.provider,
      model: res.model,
      promptVersion,
      inputHash: key,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costInr: cost,
      ms: res.ms,
      cacheHit: false,
    });
    return { ok: true, text: res.text, cost };
  }

  return {
    totals: () => ({ ...totals, spentInr: round(totals.costInr) }),
    budget,

    /**
     * Is the answer already in the cache? Asked before the "model only when
     * needed" rules, because a cached answer costs nothing and there is no
     * sense refusing something free.
     */
    async peekCache({ prompt, input }) {
      const cached = await cache.get({ provider: settings.provider, model: settings.model, promptVersion: prompt.version, input });
      return Boolean(cached.hit && typeof cached.value === 'string');
    },

    /**
     * Record a call the rules said was unnecessary. A skip with no receipt is
     * indistinguishable from a stage that never ran, so every one of them is
     * written down with the rule that decided it.
     */
    notNeeded({ purpose, leadId = null, reason }) {
      totals.notNeeded += 1;
      chain.add('llm.not_needed', { purpose, leadId, reason });
      return { purpose, leadId, reason };
    },

    /**
     * Cache, then budget, then call; one repair attempt on a malformed reply,
     * then give up and say so. Only an answer that parsed is ever cached.
     */
    async ask({ purpose, prompt, input, maxTokens, jsonMode = false, parse }) {
      const parts = { provider: settings.provider, model: settings.model, promptVersion: prompt.version, input };
      const key = inputHash(input);

      const cached = await cache.get(parts);
      if (cached.hit && typeof cached.value === 'string') {
        const parsed = parse(cached.value);
        if (parsed.ok) {
          totals.cacheHits += 1;
          chain.add('llm.cache_hit', {
            purpose,
            provider: settings.provider,
            model: settings.model,
            promptVersion: prompt.version,
            inputHash: key,
            costInr: 0,
            cacheHit: true,
          });
          return { ok: true, value: parsed.value, text: cached.value, cacheHit: true };
        }
      }

      const messages = [
        { role: 'system', content: prompt.body },
        { role: 'user', content: input },
      ];
      const first = await callModel({ purpose, promptVersion: prompt.version, messages, maxTokens, jsonMode, key });
      if (!first.ok) return { ok: false, reason: first.reason, cacheHit: false };

      let parsed = parse(first.text);
      if (parsed.ok) {
        await cache.put(parts, first.text, { at: now(), costInr: first.cost });
        return { ok: true, value: parsed.value, text: first.text, cacheHit: false };
      }

      const repair = await callModel({
        purpose: `${purpose}:repair`,
        promptVersion: prompt.version,
        messages: [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: repairMessage(parsed.reason) }],
        maxTokens,
        jsonMode,
        key,
      });
      if (repair.ok) {
        const second = parse(repair.text);
        if (second.ok) {
          await cache.put(parts, repair.text, { at: now(), costInr: repair.cost });
          return { ok: true, value: second.value, text: repair.text, cacheHit: false, repaired: true };
        }
        parsed = second;
      }

      totals.invalid += 1;
      chain.add('llm.invalid_output', {
        purpose,
        provider: settings.provider,
        model: settings.model,
        promptVersion: prompt.version,
        inputHash: key,
        reason: parsed.reason,
        repairAttempted: true,
        repairReached: repair.ok === true,
      });
      return { ok: false, reason: 'invalid', detail: parsed.reason };
    },
  };
}

function round(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// ------------------------------------------------------------------ enrich

/** The page this lead can be read from, or null. A map listing is not a page about the business. */
export function enrichUrl(lead) {
  if (lead.website) return lead.website;
  if (lead.source_url && (lead.source === 'news' || lead.source === 'cppp')) return lead.source_url;
  return null;
}

/**
 * Which leads get enriched, in what order.
 *
 * Every candidate has something to read. Order is rule score first - the stage
 * spends its limit where the score already says the money is - then leads with
 * their own website ahead of leads known only from an article, then id, so the
 * selection is deterministic.
 */
export function selectForEnrichment(leads, { limit, promptVersion }) {
  return leads
    .filter((l) => l.kind !== 'price' && enrichUrl(l))
    .filter((l) => !(l.extra && l.extra.llm && l.extra.llm.promptVersion === promptVersion))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.website ? 1 : 0) - (a.website ? 1 : 0) ||
        String(a.id).localeCompare(String(b.id))
    )
    .slice(0, limit);
}

/**
 * Read a page per lead and record what the model made of it.
 *
 * A lead whose page cannot be fetched, or whose answer cannot be read, keeps
 * every rule-based value it already had. There is no path here that writes a
 * guess into a lead.
 */
export async function enrichLeads(leads, { runner, chain = NO_CHAIN, settings, fetchImpl, pageFetcher, log = () => {} }) {
  const prompt = loadPrompt('enrich');
  const chosen = selectForEnrichment(leads, { limit: settings.enrichLimit, promptVersion: prompt.version });
  const pages = pageFetcher || createPageFetcher({ fetchImpl });
  // Where each digest section stops today. A lead well clear of its cut-off, or
  // well below it, cannot have the digest changed by anything the model reads,
  // so its size is not worth paying to learn.
  const cutoffs = digestCutoffs(leads);
  const out = { considered: chosen.length, enriched: 0, pagesRead: 0, pagesSkipped: 0, notNeeded: 0, stopped: null };

  for (const lead of chosen) {
    const url = enrichUrl(lead);
    const page = await pages.fetchText(url);
    if (!page.ok) {
      out.pagesSkipped += 1;
      chain.add('llm.page_skipped', { leadId: lead.id, url, reason: page.reason });
      continue;
    }
    out.pagesRead += 1;

    // A business's own website is asked about on its own: the page is the whole
    // answer, and leaving the record's name out of the question means three
    // outlets of one chain, all pointing at one site, share one cached answer.
    // An article is different - it has to be told which business the record is
    // about - so there the name and city go in and the cache key narrows.
    const fromArticle = !lead.website;
    const input = enrichInput({
      name: fromArticle ? lead.name : null,
      city: fromArticle ? lead.city : null,
      url: page.url,
      text: page.text,
    });

    // Model only when needed. A cached answer is free, so it is taken without
    // asking the rules; anything that would cost money is put to them first,
    // and a "no" is receipted rather than silently skipped.
    const cacheHit = await runner.peekCache({ prompt, input });
    if (!cacheHit) {
      const decision = needsModel('enrich', lead, {
        hasText: Boolean(page.text),
        cacheHit: false,
        cutoff: cutoffFor(lead, cutoffs),
      });
      if (!decision.needed) {
        out.notNeeded += 1;
        runner.notNeeded({ purpose: 'enrich', leadId: lead.id, reason: decision.reason });
        continue;
      }
    }

    const answer = await runner.ask({
      purpose: 'enrich',
      prompt,
      input,
      maxTokens: ENRICH_MAX_TOKENS,
      jsonMode: true,
      parse: parseEnrich,
    });

    if (!answer.ok) {
      if (answer.reason === 'budget') {
        // The cap is a stop, not a skip: every later lead would hit it too.
        out.stopped = 'budget';
        break;
      }
      continue;
    }

    applyEnrichment(lead, answer.value, {
      promptVersion: prompt.version,
      provider: settings.provider,
      model: settings.model,
      sourceUrl: page.url,
      pageTitle: page.title || null,
      cacheHit: answer.cacheHit,
    });
    out.enriched += 1;
    chain.add('llm.enriched', {
      leadId: lead.id,
      segmentSource: lead.segment_source,
      segmentModel: lead.segment_model,
      size: answer.value.size,
      deadline: answer.value.deadline,
      confidence: answer.value.confidence,
      cacheHit: answer.cacheHit,
    });
    log(`llm: enriched ${lead.id} ${lead.segment_source} -> ${lead.segment_model} (${answer.value.confidence})`);
  }

  return out;
}

// ------------------------------------------------------------------ opener

/** Everything the opener writer is allowed to know about a lead. */
export function openerInput(lead) {
  const llm = (lead.extra && lead.extra.llm) || {};
  const lines = [
    `Business: ${lead.name}`,
    `What it is: ${describeSegment(lead)}`,
    lead.city ? `City: ${lead.city}` : null,
    lead.why_now ? `Why now: ${lead.why_now}` : null,
    llm.size && llm.size !== 'unknown' ? `Size: ${llm.size}` : null,
    llm.quantity ? `Stated requirement: ${llm.quantity}` : null,
    llm.buys && llm.buys.length ? `Mentioned inputs: ${llm.buys.join(', ')}` : null,
    llm.deadline ? `Deadline: ${llm.deadline}` : null,
    llm.evidence && llm.evidence.length
      ? `Evidence from their own page:\n${llm.evidence.map((e) => `- ${e}`).join('\n')}`
      : 'Evidence from their own page: none',
    '',
    `${BUSINESS.name} supplies: ${BUSINESS.headline}. Owner: ${BUSINESS.owner}, ${BUSINESS.homeCity}.`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const HYPE = /\b(excited|thrilled|delighted|leading|best[- ]in|world[- ]class|cutting[- ]edge|synergy|revolution|passionate|premier|unparalleled|partner with you)\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/**
 * Read a reply into two lines. The checks here are the ones a wrong answer
 * would fail loudly: not two lines, too long, hype, an emoji. Anything that
 * fails keeps the rule-based opener, which is always correct if plain.
 */
export function parseOpener(text) {
  const lines = String(text || '')
    .replace(/```[a-z]*\n?|```/gi, '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*>]\s*/, '').replace(/^["'“”]+|["'“”]+$/g, '').trim())
    .filter(Boolean);
  if (lines.length < 2) return { ok: false, reason: `expected two lines, got ${lines.length}`, malformed: true };
  const two = lines.slice(0, 2);
  const tooLong = two.find((l) => l.length > 120);
  if (tooLong) return { ok: false, reason: `a line is ${tooLong.length} characters, over the 120 limit`, malformed: true };
  const hype = two.find((l) => HYPE.test(l));
  if (hype) return { ok: false, reason: 'the reply uses marketing language', malformed: true };
  if (two.some((l) => EMOJI.test(l))) return { ok: false, reason: 'the reply contains an emoji', malformed: true };
  return { ok: true, value: two.join('\n') };
}

/**
 * Openers for the leads the digest will actually show. Nothing else is worth a
 * call: a lead nobody will read today does not need a line written for it.
 */
export async function writeOpeners(leads, digestIndex, { runner, chain = NO_CHAIN, settings, log = () => {} }) {
  const prompt = loadPrompt('opener');
  const byId = new Map(leads.map((l) => [l.id, l]));
  const ids = Object.values(digestIndex || {}).slice(0, settings.openerTopN);
  const out = { considered: 0, written: 0, notNeeded: 0, stopped: null };

  for (const id of ids) {
    const lead = byId.get(id);
    if (!lead) continue;
    if (lead.extra && lead.extra.openerPromptVersion === prompt.version && lead.opener_model) continue;
    out.considered += 1;

    // Model only when needed. Every lead here is in the digest by construction,
    // so the question left is whether there is a concrete fact to build a line
    // on. Without one the model would be paraphrasing the trading name, and the
    // rule-based opener already does that for nothing.
    const decision = needsModel('opener', lead, { inDigest: true });
    if (!decision.needed) {
      out.notNeeded += 1;
      runner.notNeeded({ purpose: 'opener', leadId: lead.id, reason: decision.reason });
      continue;
    }

    const answer = await runner.ask({
      purpose: 'opener',
      prompt,
      input: openerInput(lead),
      maxTokens: OPENER_MAX_TOKENS,
      jsonMode: false,
      parse: parseOpener,
    });

    if (!answer.ok) {
      if (answer.reason === 'budget') {
        out.stopped = 'budget';
        break;
      }
      continue;
    }

    lead.opener_model = answer.value;
    lead.extra = { ...lead.extra, openerPromptVersion: prompt.version };
    out.written += 1;
    chain.add('llm.opener', { leadId: lead.id, chars: answer.value.length, cacheHit: answer.cacheHit });
    log(`llm: opener for ${lead.id}`);
  }

  return out;
}

export { ruleOpener };
