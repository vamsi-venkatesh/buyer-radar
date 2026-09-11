// The scheduler. One long-lived process that runs the daily pipeline at
// RADAR_RUN_AT wall-clock time in RADAR_TZ, for each city in RADAR_CITIES, and
// then delivers the digest to the owner through whatever channels RADAR_DELIVER
// names. No system cron, no dependency.
//
//   node src/cron.mjs           run forever, waking once a day
//   node src/cron.mjs --once    run the pipeline now, then exit
//   node src/cron.mjs --print   print the next few run times and exit
//
// One city is one run and therefore one digest and one message. Cities are run
// one after another, never in parallel, so the polite per-source pauses in each
// source still hold.

import { CITIES } from './config.mjs';
import { nextRunAt, waitUntil, zonedParts, parseTimeOfDay } from './lib/schedule.mjs';
import { parseChannels } from './deliver.mjs';
import { run } from './run.mjs';

export const CRON_DEFAULTS = {
  at: '07:00',
  timeZone: 'Asia/Kolkata',
  cities: ['bengaluru'],
  sources: ['overpass', 'news', 'agmarknet'],
  limit: 200,
  deliver: [],
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
  return { at, timeZone, cities, sources, limit, deliver: parseChannels(env.RADAR_DELIVER || '') };
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

/** One pass: every city, in order, delivering after each city's digest. */
export async function runOnce(config, { log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const results = [];
  for (const city of config.cities) {
    log(`[cron] ${city}: starting`);
    try {
      const result = await run(
        { city, sources: config.sources, limit: config.limit, dry: false, deliver: config.deliver },
        { log }
      );
      for (const d of result.delivered || []) {
        log(`[cron] ${city}: ${d.channel} ${d.sent ? `sent to ${d.to}` : d.reason}`);
      }
      results.push({ city, ok: true, runId: result.runId, delivered: result.delivered || [] });
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
      // One city failing must not stop the others, and must not stop tomorrow.
      log(`[cron] ${city}: FAILED ${err.name}: ${err.message}`);
      results.push({ city, ok: false, error: `${err.name}: ${err.message}` });
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
      `at ${config.at} ${config.timeZone} | deliver ${config.deliver.join(',') || 'none'}\n`
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
