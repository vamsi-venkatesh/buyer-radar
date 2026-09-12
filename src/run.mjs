import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CITIES, EVIDENCE_SCHEMA, RUN, INSTITUTIONS, openingsMaxReads } from './config.mjs';
import { RUNS_DIR } from './lib/paths.mjs';
import { ReceiptChain } from './lib/receipts.mjs';
import { openStore } from './lib/store.mjs';
import { toLead, upsertLeads, scoreLead } from './model.mjs';
import { todayIso } from './lib/normalise.mjs';
import { renderDigest, writeDigest, diversifyTies, renderPriceSheet } from './digest.mjs';
import { deliver, parseChannels, CHANNELS } from './deliver.mjs';
import { llmSettings } from './llm/settings.mjs';
import { createRunner, enrichLeads, writeOpeners } from './llm/stage.mjs';

import * as openings from './sources/openings.mjs';
import { SOURCES, STAGES } from './sources/all.mjs';
import { createCrawler } from './lib/crawl.mjs';

export function parseArgs(argv) {
  const out = { city: 'bengaluru', sources: ['overpass', 'news'], limit: 200, dry: false, deliver: [], noLlm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-llm') out.noLlm = true;
    else if (a === '--city') out.city = String(argv[++i] || '').toLowerCase();
    else if (a === '--sources') out.sources = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--deliver') out.deliver = parseChannels(argv[++i]);
    else if (a === '--dry') out.dry = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!CITIES[out.city]) throw new Error(`unknown city: ${out.city} (known: ${Object.keys(CITIES).join(', ')})`);
  for (const s of out.sources) {
    if (!SOURCES[s] && !STAGES[s]) {
      throw new Error(`unknown source: ${s} (known: ${[...Object.keys(SOURCES), ...Object.keys(STAGES)].join(', ')})`);
    }
  }
  out.stages = out.sources.filter((s) => STAGES[s]);
  out.fetchSources = out.sources.filter((s) => SOURCES[s]);
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new Error('--limit must be a positive number');
  return out;
}

const USAGE = `
Buyer Radar

  node src/run.mjs --city bengaluru --sources overpass,news,cppp --limit 200 [--dry]

  --city     one of: ${Object.keys(CITIES).join(', ')}
  --sources  comma list of: ${[...Object.keys(SOURCES), ...Object.keys(STAGES)].join(', ')}
             institutions, gem, registrations and exporters are the demand lane:
             buyers who have POSTED a requirement. publishers reads the direct
             RSS/Atom feeds in config/publisher-feeds.json and is where the
             openings lane's articles come from. openings is not a fetch - it
             upgrades the news and publishers signals this run already found
             into requirements with a contact, inside the model stage.
  --limit    maximum candidates carried into the register this run
  --deliver  comma list of: ${CHANNELS.join(', ')} - send the digest to the OWNER
  --dry      fetch, normalise and score, but write nothing
  --no-llm   skip the LLM stage for this run; the rules alone decide every score

--deliver sends the morning digest to the owner's own address, configured by him
in his own environment. It never messages a buyer. With no channel configured
the message is written to outbox/ and the run records why it was not sent.
`;

/**
 * Apply --limit without letting one source take every slot.
 *
 * Map listings carry phone numbers and therefore always outscore a news signal
 * or a tender, so a straight top-N cut would drop the news and tender lanes
 * entirely. Each contributing source is first guaranteed up to
 * RUN.reservePerSource of the limit, taken from its own best-scoring
 * candidates; the remaining slots are then filled in global score order, with
 * ties spread across segments. Deterministic.
 */
export function capCandidates(sortedLeads, limit, reserveFraction = RUN.reservePerSource) {
  if (sortedLeads.length <= limit) return diversifyTies(sortedLeads);

  const bySource = new Map();
  for (const lead of sortedLeads) {
    if (!bySource.has(lead.source)) bySource.set(lead.source, []);
    bySource.get(lead.source).push(lead);
  }

  const reserve = Math.floor(limit * reserveFraction);
  const chosen = new Set();
  for (const source of [...bySource.keys()].sort()) {
    for (const lead of bySource.get(source).slice(0, reserve)) chosen.add(lead.id);
  }
  for (const lead of diversifyTies(sortedLeads)) {
    if (chosen.size >= limit) break;
    chosen.add(lead.id);
  }
  return diversifyTies(sortedLeads.filter((l) => chosen.has(l.id))).slice(0, limit);
}

export async function run(
  opts,
  {
    log = (m) => process.stderr.write(`${m}\n`),
    env = process.env,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  const city = CITIES[opts.city];
  const runId = `run_${todayIso().replace(/-/g, '')}_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const chain = new ReceiptChain(runId, EVIDENCE_SCHEMA);

  chain.add('run.created', {
    runId,
    city: city.key,
    sources: opts.sources,
    limit: opts.limit,
    dry: Boolean(opts.dry),
    startedAt,
  });

  const ctx = { city, limit: opts.limit, log };
  const candidates = [];
  const perSource = {};
  const blocked = [];

  for (const sourceName of opts.fetchSources || opts.sources.filter((n) => SOURCES[n])) {
    const mod = SOURCES[sourceName];
    const t0 = Date.now();
    let result;
    try {
      // `soFar` is the candidates the sources before this one produced. The
      // publisher-feed lane uses it to drop a headline the news lane already
      // holds, which is a thing it can only know from inside this loop.
      result = await mod.fetch({ ...ctx, env, fetchImpl, todayIsoDate: todayIso(), soFar: candidates });
    } catch (err) {
      const reason = `${err.name}: ${err.message}`;
      log(`${sourceName}: ERROR ${reason}`);
      result = { candidates: [], blocked: { source: sourceName, reason, kind: 'error' } };
    }
    const ms = Date.now() - t0;
    const got = result.candidates || [];
    perSource[sourceName] = { count: got.length, ms, blocked: result.blocked || null };
    candidates.push(...got);
    chain.add('source.fetched', { source: sourceName, count: got.length, ms, detail: result.detail || null });
    if (result.blocked) {
      blocked.push(result.blocked);
      chain.add('source.blocked', {
        source: sourceName,
        reason: result.blocked.reason,
        kind: result.blocked.kind || 'http',
        status: result.blocked.status ?? null,
      });
    }
  }

  // Normalise, score, cap.
  const nowIso = new Date().toISOString();
  const today = todayIso();
  const leadsIn = candidates.map((c) => toLead(c, { nowIso }));
  for (const lead of leadsIn) {
    const { score, parts } = scoreLead(lead, { city: city.name, state: city.state, todayIsoDate: today });
    lead.score = score;
    lead.extra.scoreParts = parts;
  }
  leadsIn.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const capped = capCandidates(leadsIn, opts.limit);

  const store = await openStore();
  let merged;
  try {
    const existing = await store.allLeads();
    merged = upsertLeads(existing, capped);

    // The LLM stage sits here on purpose: after dedup, so a page is read once
    // for one lead rather than once per sighting, and before scoring, so the
    // rules can use what it read. It is skipped on a dry run - a dry run spends
    // no money and writes no cache - and whenever there is no key, no model or
    // the switch is off. Every one of those paths leaves the scores exactly as
    // the rules alone would have set them.
    const settings = llmSettings(env, { noLlm: Boolean(opts.noLlm) || Boolean(opts.dry) });
    const llm = {
      enabled: settings.enabled,
      reason: settings.reason,
      provider: settings.enabled ? settings.provider : null,
      model: settings.enabled ? settings.model : null,
      calls: 0,
      cacheHits: 0,
      costInr: 0,
      budgetSkipped: 0,
      notNeeded: 0,
      invalid: 0,
      errors: 0,
      enriched: 0,
      openers: 0,
      pagesRead: 0,
      pagesSkipped: 0,
    };
    let runner = null;
    let openingsSummary = null;
    if (!settings.enabled) {
      const reason = opts.dry && !opts.noLlm ? '--dry run' : settings.reason;
      llm.reason = reason;
      chain.add('llm.disabled', { reason, provider: settings.provider || null });
      if ((opts.stages || []).includes('openings')) {
        openingsSummary = { skipped: `the openings lane needs the model stage, which is off: ${reason}` };
        chain.add('openings.skipped', { reason });
      }
    } else {
      runner = createRunner({ store, chain, settings, day: today, fetchImpl, env });
      const enriched = await enrichLeads(merged.leads, { runner, chain, settings, fetchImpl, log });
      llm.enriched = enriched.enriched;
      llm.pagesRead = enriched.pagesRead;
      llm.pagesSkipped = enriched.pagesSkipped;
      llm.consideredForEnrichment = enriched.considered;
      if (enriched.stopped) llm.stoppedEnrichment = enriched.stopped;

      // The openings lane: a news signal becomes a requirement only once the
      // model has read a requirement out of the article AND a contact has been
      // read off the organisation's own site. Without both it stays a signal.
      if ((opts.stages || []).includes('openings')) {
        const crawler = createCrawler({
          fetchImpl,
          perHostPauseMs: INSTITUTIONS.pauseMs,
          timeoutMs: INSTITUTIONS.httpTimeoutMs,
        });
        const upgraded = await openings.upgradeSignals(merged.leads, {
          runner,
          crawler,
          chain,
          settings,
          todayIsoDate: today,
          fetchImpl,
          maxReads: openingsMaxReads(env),
          log,
        });
        openingsSummary = { ...upgraded, crawler: crawler.stats() };
        chain.add('openings.finished', {
          considered: upgraded.considered,
          requirementCandidates: upgraded.requirementCandidates,
          awarenessOnly: upgraded.awarenessOnly,
          readCap: upgraded.readCap,
          capReached: upgraded.capReached,
          cappedOut: upgraded.cappedOut,
          linksResolved: upgraded.linksResolved,
          linksUnresolved: upgraded.linksUnresolved,
          articlesRead: upgraded.articlesRead,
          notNeeded: upgraded.notNeeded,
          requirementsSeen: upgraded.requirementsSeen,
          contactsFound: upgraded.contactsFound,
          upgraded: upgraded.upgraded,
        });
      }
      Object.assign(llm, runner.totals());
    }

    // Rescore after merge so penalties, merged facts and anything the model read
    // are reflected. The rules decide the number either way.
    for (const lead of merged.leads) {
      const { score, parts, inputs } = scoreLead(lead, { city: city.name, state: city.state, todayIsoDate: today });
      lead.score = score;
      lead.extra = { ...lead.extra, scoreParts: parts, scoreInputs: inputs };
    }

    chain.add('leads.upserted', {
      new: merged.newCount,
      updated: merged.updatedCount,
      duplicatesMerged: merged.duplicateCount,
      total: merged.leads.length,
      dry: Boolean(opts.dry),
    });

    const prices = merged.leads.filter((l) => l.kind === 'price');
    const buyers = merged.leads.filter((l) => l.kind !== 'price');
    const requirements = buyers.filter((l) => l.kind === 'requirement');
    let digest = renderDigest(buyers, { date: today, city: city.name, prices });

    // Openers are written only for the leads the digest actually selected, so
    // the digest is rendered once to find out which those are, and once more to
    // show the lines that came back.
    if (runner) {
      const openers = await writeOpeners(buyers, digest.index, { runner, chain, settings, log });
      llm.openers = openers.written;
      if (openers.stopped) llm.stoppedOpeners = openers.stopped;
      Object.assign(llm, runner.totals());
      if (openers.written) digest = renderDigest(buyers, { date: today, city: city.name, prices });
    }
    digest.priceSheet = renderPriceSheet(prices, { date: today, state: city.agmarknetState || null });
    chain.add('digest.rendered', {
      date: today,
      chars: digest.text.length,
      shown: digest.shown,
      considered: digest.considered,
      requirementsShown: digest.requirementsShown,
      requirementsConsidered: digest.requirementsConsidered,
      requirementsWithContact: digest.withContact,
      fullSheetChars: digest.full ? digest.full.length : 0,
    });

    // Delivery. The only recipient is the owner's own address. A channel that
    // is not configured writes to outbox/ and records why it did not send.
    let delivered = [];
    if (opts.deliver && opts.deliver.length) {
      if (opts.dry) {
        for (const channel of opts.deliver) {
          const result = { channel, sent: false, reason: 'not sent: --dry run' };
          delivered.push(result);
          chain.add('digest.not_sent', { channel, reason: result.reason });
        }
      } else {
        delivered = await deliver(opts.deliver, {
          date: today,
          digestText: digest.text,
          fullSheet: digest.full,
          priceSheet: digest.priceSheet,
          stats: {
            leads: buyers.length,
            withPhone: buyers.filter((l) => l.phone).length,
            requirements: requirements.length,
            requirementsWithContact: requirements.filter((l) => l.phone || l.email).length,
          },
        });
        for (const result of delivered) {
          if (result.sent) {
            chain.add('digest.delivered', {
              channel: result.channel,
              to: result.to || null,
              bytes: result.bytes ?? null,
              chars: result.chars ?? null,
            });
          } else {
            chain.add('digest.not_sent', {
              channel: result.channel,
              reason: result.reason,
              file: result.file || null,
            });
          }
        }
      }
    }

    const bundle = chain.seal();
    const summary = {
      perSource,
      blocked,
      candidates: candidates.length,
      capped: capped.length,
      leadsTotal: merged.leads.length,
      leadsWithPhone: merged.leads.filter((l) => l.phone).length,
      leadsWithEmail: merged.leads.filter((l) => l.email).length,
      digestChars: digest.text.length,
      requirements: requirements.length,
      requirementsWithContact: requirements.filter((l) => l.phone || l.email).length,
      registrations: merged.leads.filter((l) => l.kind === 'registration').length,
      openings: openingsSummary,
      delivered: delivered.map((r) => ({ channel: r.channel, sent: r.sent, reason: r.reason || null })),
      llm,
    };

    if (!opts.dry) {
      await store.putLeads(merged.leads);
      await store.putRun({
        id: runId,
        city: city.key,
        sources: opts.sources,
        startedAt,
        finishedAt: new Date().toISOString(),
        dry: false,
        summary,
        bundleHash: bundle.hash,
      });
      await store.appendEvents(bundle.receipts.map((r) => ({ ...r, runId })));
      await mkdir(RUNS_DIR, { recursive: true });
      await writeFile(
        path.join(RUNS_DIR, `${runId}.evidence.json`),
        `${JSON.stringify(bundle, null, 2)}\n`,
        'utf8'
      );
      await writeDigest(digest, today);
    }

    return { runId, bundle, digest, summary, delivered, store: store.describe(), dry: Boolean(opts.dry) };
  } finally {
    await store.close();
  }
}

/**
 * The openings lane in one line: what it read, what it kept without reading,
 * and whether the per-run cap stopped it.
 *
 * Articles read and awareness-only are the two numbers that say whether the
 * lane is spending on the right things. A run that considered 13 signals, read
 * 0 articles and kept 11 as awareness spent nothing on stories that could not
 * have contained a requirement - which is the whole point of the tiers.
 */
export function openingsLine(openings) {
  if (!openings) return '';
  if (openings.skipped) return String(openings.skipped);
  return (
    `${openings.considered} signals (${openings.requirementCandidates ?? 0} requirement candidates, ` +
    `${openings.awarenessOnly ?? 0} awareness-only - no fetch, no model), ` +
    `${openings.articlesRead} articles read of a cap of ${openings.readCap ?? '-'}` +
    `${openings.capReached ? ` (cap reached, ${openings.cappedOut ?? 0} candidates left unread)` : ''}, ` +
    `${openings.linksResolved ?? 0} links resolved to a publisher (${openings.linksUnresolved ?? 0} not), ` +
    `${openings.requirementsSeen} state a requirement, ${openings.contactsFound} contacts found, ${openings.upgraded} upgraded`
  );
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    process.exit(2);
    return;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const result = await run(opts);
  const s = result.summary;
  process.stdout.write(`${result.digest.text}\n`);
  process.stderr.write('\n--- run summary ---\n');
  process.stderr.write(`run id       ${result.runId}\n`);
  process.stderr.write(`store        ${result.store}${result.dry ? ' (dry: nothing written)' : ''}\n`);
  for (const [name, d] of Object.entries(s.perSource)) {
    process.stderr.write(
      `source       ${name}: ${d.count} candidates in ${d.ms} ms${d.blocked ? ` | BLOCKED: ${d.blocked.reason}` : ''}\n`
    );
  }
  process.stderr.write(`leads total  ${s.leadsTotal} (phone ${s.leadsWithPhone}, email ${s.leadsWithEmail})\n`);
  process.stderr.write(`requirements ${s.requirements ?? 0} posted (${s.requirementsWithContact ?? 0} with a contact), ${s.registrations ?? 0} registration routes\n`);
  if (s.openings) process.stderr.write(`openings     ${openingsLine(s.openings)}\n`);
  process.stderr.write(`digest       ${s.digestChars} chars, ${result.digest.shown} leads shown\n`);
  if (s.llm) {
    process.stderr.write(
      s.llm.enabled
        ? `llm          ${s.llm.provider}/${s.llm.model}: ${s.llm.calls} calls, ${s.llm.notNeeded ?? 0} not needed, ${s.llm.cacheHits} cache hits, Rs ${s.llm.costInr} spent, ${s.llm.budgetSkipped} skipped by budget\n` +
          `llm          ${s.llm.enriched} leads enriched, ${s.llm.openers} openers, ${s.llm.pagesRead} pages read, ${s.llm.pagesSkipped} pages skipped, ${s.llm.invalid} unreadable replies, ${s.llm.errors} errors\n`
        : `llm          off: ${s.llm.reason}\n`
    );
  }
  for (const d of result.delivered || []) {
    process.stderr.write(
      `deliver      ${d.channel}: ${d.sent ? `sent to ${d.to}` : `${d.reason}${d.file ? ` (written to ${d.file})` : ''}`}\n`
    );
  }
  process.stderr.write(`bundle hash  ${result.bundle.hash}\n`);
  if (!result.dry) {
    process.stderr.write(`bundle file  runs/${result.runId}.evidence.json\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
