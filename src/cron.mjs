// The scheduler. One long-lived process that runs the daily pipeline at
// RADAR_RUN_AT wall-clock time in RADAR_TZ, for each city in RADAR_CITIES, and
// then delivers the digest to the owner through whatever channels RADAR_DELIVER
// names. No system cron, no dependency.
//
//   node src/cron.mjs           run forever, waking once a day
//   node src/cron.mjs --once    run the pipeline now, then exit
//   node src/cron.mjs --print   print the next few run times and exit
//
// Cities are run one after another, never in parallel, so the polite
// per-source pauses in each source still hold. One city is one run, one
// evidence bundle and one set of receipts - but NOT one message. In the default
// `combined` mode the pass delivers once, after the last city, because Meta
// applies a per-recipient frequency cap to a MARKETING template and a
// multi-city morning is refused partway through. `per-city` restores the old
// shape.

import { CITIES, EVIDENCE_SCHEMA } from './config.mjs';
import { nextRunAt, waitUntil, zonedParts, parseTimeOfDay } from './lib/schedule.mjs';
import { parseChannels, deliver as deliverDefault } from './deliver.mjs';
import { combineDigests, writeCombinedDigest } from './digest.mjs';
import { appendDayBundle } from './lib/receipts.mjs';
import { recordDigestMessages } from './digest-delivery.mjs';
import { openStore } from './lib/store.mjs';
import { todayIso } from './lib/normalise.mjs';
import { run } from './run.mjs';

export const DELIVER_MODES = ['combined', 'per-city'];

export const CRON_DEFAULTS = {
  at: '07:00',
  timeZone: 'Asia/Kolkata',
  cities: ['bengaluru'],
  sources: ['overpass', 'news', 'agmarknet'],
  limit: 200,
  deliver: [],
  deliverMode: 'combined',
};

/** Read the schedule out of the environment, validating every value. */
export function cronConfig(env = process.env) {
  const at = env.RADAR_RUN_AT || CRON_DEFAULTS.at;
  parseTimeOfDay(at); // throws on anything that is not HH:MM
  const timeZone = env.RADAR_TZ || CRON_DEFAULTS.timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`RADAR_TZ is not a time zone this Node knows: ${timeZone}`);
  }
  const cities = (env.RADAR_CITIES || CRON_DEFAULTS.cities.join(','))
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  if (!cities.length) throw new Error('RADAR_CITIES is empty');
  for (const c of cities) {
    if (!CITIES[c]) throw new Error(`RADAR_CITIES names an unknown city: ${c} (known: ${Object.keys(CITIES).join(', ')})`);
  }
  const sources = (env.RADAR_SOURCES || CRON_DEFAULTS.sources.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Number(env.RADAR_LIMIT || CRON_DEFAULTS.limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`RADAR_LIMIT must be a positive number, got: ${env.RADAR_LIMIT}`);
  const deliverMode = String(env.RADAR_DELIVER_MODE || CRON_DEFAULTS.deliverMode).trim().toLowerCase();
  if (!DELIVER_MODES.includes(deliverMode)) {
    throw new Error(`RADAR_DELIVER_MODE must be one of: ${DELIVER_MODES.join(', ')} (got: ${env.RADAR_DELIVER_MODE})`);
  }
  return { at, timeZone, cities, sources, limit, deliver: parseChannels(env.RADAR_DELIVER || ''), deliverMode };
}

/** The next `count` run instants after `from`. Used by --print and by the tests. */
export function upcoming(config, from = new Date(), count = 3) {
  const out = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const next = nextRunAt(cursor, { at: config.at, timeZone: config.timeZone });
    out.push(next);
    cursor = next;
  }
  return out;
}

function stamp(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${timeZone}`;
}

/**
 * Deliver ONE combined digest for the whole morning.
 *
 * The city runs have already written their own run rows, bundles and receipts;
 * this is the delivery they no longer do themselves. It composes one message
 * from what every city ranked, sends it through each configured channel, writes
 * it to digests/<date>.txt so the dashboard and the owner's WhatsApp reply hand
 * back the message he was actually sent, and records one receipt per channel -
 * carrying the cities it stood for and, when Meta refuses it, Meta's own error
 * code.
 */
export async function deliverCombined(
  cityResults,
  {
    channels = [],
    date = todayIso(),
    log = () => {},
    deliverImpl = deliverDefault,
    openStoreImpl = openStore,
    writeCombined = writeCombinedDigest,
    appendBundle = appendDayBundle,
    runsDir,
    digestsDir,
  } = {}
) {
  const ok = cityResults.filter((r) => r.ok && r.delivery).map((r) => r.delivery);
  const failed = cityResults.filter((r) => !r.ok).map((r) => ({ city: CITIES[r.city]?.name || r.city, error: r.error }));
  const combined = combineDigests(ok, { date, failed });

  await writeCombined(combined, date, digestsDir ? { digestsDir } : {});

  const stats = ok.reduce(
    (acc, d) => ({
      leads: acc.leads + (d.stats?.leads || 0),
      withPhone: acc.withPhone + (d.stats?.withPhone || 0),
      requirements: acc.requirements + (d.stats?.requirements || 0),
      requirementsWithContact: acc.requirementsWithContact + (d.stats?.requirementsWithContact || 0),
    }),
    { leads: 0, withPhone: 0, requirements: 0, requirementsWithContact: 0 }
  );

  let delivered = [];
  if (channels.length) {
    delivered = await deliverImpl(channels, {
      date,
      digestText: combined.text,
      fullSheet: combined.full,
      priceSheet: combined.priceSheet,
      cities: combined.cities,
      stats,
    });
  }

  const emailSent = delivered.some((r) => r.channel === 'email' && r.sent);

  const entries = delivered.map((result) =>
    result.sent
      ? {
          type: 'digest.delivered',
          data: {
            channel: result.channel,
            date,
            cities: combined.cities,
            citiesFailed: combined.failedCities,
            to: result.to || null,
            via: result.via || null,
            bytes: result.bytes ?? null,
            chars: result.chars ?? null,
            // A 200 from the Cloud API is not a delivery. The id is recorded
            // because the status that says whether this message arrived quotes
            // it, minutes later, on the webhook.
            messageId: result.messageId || null,
            messageIds: result.messageIds || null,
            // A template send means the text was refused first. The refusal is
            // recorded even on a delivery that succeeded.
            textRefused: result.textRefused || null,
          },
        }
      : {
          type: 'digest.not_sent',
          data: {
            channel: result.channel,
            date,
            cities: combined.cities,
            citiesFailed: combined.failedCities,
            reason: result.reason,
            errorCode: result.error?.code ?? null,
            errorMessage: result.error?.message ?? null,
            file: result.file || null,
          },
        }
  );

  let bundle = null;
  if (entries.length) {
    bundle = await appendBundle(`delivery_${date}`, entries, { runsDir, schema: EVIDENCE_SCHEMA });
    const store = await openStoreImpl();
    try {
      await store.appendEvents(
        entries.map((e) => ({ type: e.type, at: new Date().toISOString(), key: null, runId: `delivery_${date}`, ...e.data }))
      );
      // One lookup row per accepted WhatsApp message. Without it the webhook
      // has nothing to match a failed status against and the morning would keep
      // its tick for a message that never arrived.
      for (const result of delivered) {
        if (result.channel !== 'whatsapp') continue;
        await recordDigestMessages(store, {
          date,
          runId: `delivery_${date}`,
          cities: combined.cities,
          whatsapp: result,
          emailSent,
        });
      }
    } finally {
      await store.close();
    }
  }

  for (const d of delivered) {
    log(`[cron] combined: ${d.channel} ${d.sent ? `sent to ${d.to || 'the owner'} for ${combined.cities.join(', ') || 'no city'}` : d.reason}`);
  }
  return { combined, delivered, bundle };
}

/**
 * One pass: every city, in order.
 *
 * In `combined` mode the per-city runs deliver nothing and one message goes out
 * after the last city. In `per-city` mode each run delivers its own digest, as
 * it did before. A city that fails is logged, does not stop the others, and is
 * named in the combined digest.
 */
export async function runOnce(
  config,
  { log = (m) => process.stderr.write(`${m}\n`), date = todayIso(), runImpl = run, ...hooks } = {}
) {
  const combinedMode = (config.deliverMode || CRON_DEFAULTS.deliverMode) === 'combined';
  const results = [];
  for (const city of config.cities) {
    log(`[cron] ${city}: starting`);
    try {
      const result = await runImpl(
        {
          city,
          sources: config.sources,
          limit: config.limit,
          dry: false,
          deliver: combinedMode ? [] : config.deliver,
        },
        { log }
      );
      for (const d of result.delivered || []) {
        log(`[cron] ${city}: ${d.channel} ${d.sent ? `sent to ${d.to}` : d.reason}`);
      }
      results.push({ city, ok: true, runId: result.runId, delivered: result.delivered || [], delivery: result.delivery || null });
      log(`[cron] ${city}: ${result.runId} ${result.summary.leadsTotal} leads in the register`);
      const llm = result.summary.llm;
      if (llm) {
        log(
          llm.enabled
            ? `[cron] ${city}: llm ${llm.calls} calls, ${llm.cacheHits} cached, Rs ${llm.costInr}, ${llm.budgetSkipped} skipped by budget`
            : `[cron] ${city}: llm off - ${llm.reason}`
        );
      }
    } catch (err) {
      // One city failing must not stop the others, must not stop the combined
      // delivery, and must not stop tomorrow.
      log(`[cron] ${city}: FAILED ${err.name}: ${err.message}`);
      results.push({ city, ok: false, error: `${err.name}: ${err.message}` });
    }
  }

  // The return value stays one entry per city, as it always was; the morning's
  // single delivery is attached beside it rather than pretending to be a city.
  if (combinedMode) {
    try {
      const { combined, delivered } = await deliverCombined(results, {
        channels: config.deliver || [],
        date,
        log,
        ...hooks,
      });
      results.combined = { cities: combined.cities, failedCities: combined.failedCities, chars: combined.text.length, delivered };
    } catch (err) {
      log(`[cron] combined delivery FAILED ${err.name}: ${err.message}`);
      results.combined = { error: `${err.name}: ${err.message}` };
    }
  }
  return results;
}

export function startScheduler(config, { log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  let cancel = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const target = nextRunAt(new Date(), { at: config.at, timeZone: config.timeZone });
    log(`[cron] next run ${stamp(target, config.timeZone)} (${target.toISOString()})`);
    cancel = waitUntil(target, () => {
      runOnce(config, { log })
        .catch((err) => log(`[cron] pass failed: ${err.stack || err}`))
        .finally(schedule);
    });
  };
  schedule();
  return () => {
    stopped = true;
    if (cancel) cancel();
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const config = cronConfig();
  process.stderr.write(
    `[cron] ${config.cities.join(', ')} | sources ${config.sources.join(',')} | limit ${config.limit} | ` +
      `at ${config.at} ${config.timeZone} | deliver ${config.deliver.join(',') || 'none'} (${config.deliverMode})\n`
  );
  if (argv.includes('--print')) {
    for (const d of upcoming(config, new Date(), 3)) {
      process.stdout.write(`${stamp(d, config.timeZone)}  ${d.toISOString()}\n`);
    }
    return;
  }
  if (argv.includes('--once')) {
    await runOnce(config);
    return;
  }
  const stop = startScheduler(config);
  // Keep the process alive; waitUntil unrefs its timers so it cannot hold the
  // loop open by itself.
  const keepAlive = setInterval(() => {}, 1 << 30);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.stderr.write(`\n[cron] ${signal}, stopping\n`);
      stop();
      clearInterval(keepAlive);
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
