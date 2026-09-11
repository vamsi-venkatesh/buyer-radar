// Probe every institutional registry entry once, for real, and write down what
// answered.
//
// This is not part of the daily run. It exists so the registry can be honest:
// it was written by hand from public knowledge, some of those tender pages have
// moved or never existed at that path, and the only way to know which is to ask
// each one politely, once. The result is config/institutional-buyers.probe.json,
// which the source then reads so a dead entry is skipped rather than fetched
// every morning.
//
//   node tools/probe-institutions.mjs [--notices N] [--out FILE] [--only NAME]
//
// --notices follows up to N matching notices per entry (default 0: listing pages
// only, which is all the probe needs to record). Everything obeys robots.txt and
// leaves 3 s between requests to the same host.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/lib/paths.mjs';
import { INSTITUTIONS, USER_AGENT } from '../src/config.mjs';
import { createCrawler, mapPool } from '../src/lib/crawl.mjs';
import { loadRegistry, fetchEntry } from '../src/sources/institutions.mjs';
import { todayIso } from '../src/lib/normalise.mjs';

function parseArgs(argv) {
  const out = { notices: 0, out: path.join(ROOT, INSTITUTIONS.probeFile), only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--notices') out.notices = Number(argv[++i]);
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') out.only = String(argv[++i]).toLowerCase();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = await loadRegistry();
  const registry = opts.only ? all.filter((e) => e.name.toLowerCase().includes(opts.only)) : all;
  const crawler = createCrawler({
    perHostPauseMs: INSTITUTIONS.pauseMs,
    maxBytes: INSTITUTIONS.maxBytes,
    maxTextChars: INSTITUTIONS.maxNoticeTextChars,
    timeoutMs: INSTITUTIONS.httpTimeoutMs,
  });
  const startedAt = new Date().toISOString();
  const log = (m) => process.stderr.write(`${m}\n`);

  const results = await mapPool(registry, INSTITUTIONS.concurrency, async (entry) => {
    const { record, candidates } = await fetchEntry(entry, {
      crawler,
      maxNotices: opts.notices,
      todayIsoDate: todayIso(),
      log,
    });
    log(
      `${record.reachable ? 'OK  ' : 'DEAD'} ${record.name} - ` +
        `${record.notice_links_found} matching notice links` +
        (record.reachable ? '' : ` (${String(record.reason).slice(0, 120)})`)
    );
    return { record, candidates };
  });

  const entries = results.map((r) => r.record);
  const summary = {
    total: entries.length,
    reachable: entries.filter((e) => e.reachable).length,
    withMatchingNotices: entries.filter((e) => e.notice_links_found > 0).length,
    noticesRead: entries.reduce((n, e) => n + e.notices_read, 0),
    noticesUnreadable: entries.reduce((n, e) => n + e.notices_unreadable, 0),
    contactsFound: entries.reduce((n, e) => n + e.contacts_found, 0),
  };

  const bundle = {
    _about:
      'One real probe of every entry in config/institutional-buyers.json. reachable=false means no listed tender path answered with a readable page on this date; the source skips those entries until this file is rebuilt.',
    probedAt: startedAt,
    finishedAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    noticesFollowedPerEntry: opts.notices,
    summary,
    crawler: crawler.stats(),
    entries,
  };
  await writeFile(opts.out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  process.stderr.write(
    `\n--- probe summary ---\n` +
      `entries        ${summary.total}\n` +
      `reachable      ${summary.reachable}\n` +
      `with notices   ${summary.withMatchingNotices}\n` +
      `notices read   ${summary.noticesRead} (${summary.noticesUnreadable} unreadable)\n` +
      `contacts       ${summary.contactsFound}\n` +
      `written to     ${path.relative(ROOT, opts.out)}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
