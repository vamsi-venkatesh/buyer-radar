// Probe every candidate publisher feed once, for real, and write down what
// answered.
//
// This is not part of the daily run. The feed list was written by hand from
// public knowledge of who publishes what in India, and a hand-written list of
// URLs is a list of guesses until somebody asks each one. Four facts are
// recorded per feed, and all four come from the network, not from an assumption:
//
//   1. what the feed URL answered - status, content type, bytes, milliseconds;
//   2. how many items it actually carries, read as RSS or as Atom;
//   3. whether robots.txt allows us the feed path itself;
//   4. whether robots.txt allows us the ARTICLE path of the first item - which
//      is the thing the openings lane will go and read.
//
// With --articles it also fetches that first article through the same crawler
// the daily run uses, so "fetchable" is a thing observed rather than inferred
// from a rule. A feed that fails 1-4 is dropped from config/publisher-feeds.json
// by hand, and this file keeps the reason.
//
//   node tools/probe-publisher-feeds.mjs [--out FILE] [--only NAME] [--articles]
//
// Everything obeys robots.txt for article pages and leaves 3 s between requests
// to the same host.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/lib/paths.mjs';
import { PUBLISHERS, USER_AGENT } from '../src/config.mjs';
import { createCrawler, mapPool } from '../src/lib/crawl.mjs';
import { robotsAllows, uaToken } from '../src/llm/page.mjs';
import { parseFeedItems } from '../src/lib/xml.mjs';
import { loadFeeds, fetchFeed, createPacer, articleUrl, matchItem } from '../src/sources/publishers.mjs';
import { stripTags } from '../src/lib/xml.mjs';
import { tidy } from '../src/lib/normalise.mjs';

function parseArgs(argv) {
  const out = { out: path.join(ROOT, PUBLISHERS.probeFile), only: null, articles: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') out.only = String(argv[++i]).toLowerCase();
    else if (argv[i] === '--articles') out.articles = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

/** The robots verdict for one path, and where the verdict came from. */
async function robotsVerdict(crawler, href, agent) {
  const url = new URL(href);
  const robots = await crawler.robotsFor(url.origin);
  return {
    origin: url.origin,
    path: url.pathname + url.search,
    allowed: robotsAllows(robots, url.pathname + url.search),
    robotsTxt: robots.source,
    group: robots.matched || 'no group for us and no *',
    agent,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = await loadFeeds();
  const feeds = opts.only ? all.filter((e) => e.name.toLowerCase().includes(opts.only)) : all;
  const agent = uaToken(USER_AGENT);
  const crawler = createCrawler({
    perHostPauseMs: PUBLISHERS.pauseMs,
    timeoutMs: PUBLISHERS.httpTimeoutMs,
  });
  const pace = createPacer();
  const startedAt = new Date().toISOString();
  const log = (m) => process.stderr.write(`${m}\n`);

  const entries = await mapPool(feeds, PUBLISHERS.concurrency, async (entry) => {
    const record = {
      name: entry.name,
      publisher: entry.publisher || null,
      url: entry.url,
      category: entry.category || null,
      city: entry.city || null,
      status: null,
      contentType: null,
      bytes: null,
      ms: null,
      items: 0,
      matchingItems: 0,
      firstItem: null,
      feedRobots: null,
      articleRobots: null,
      article: null,
      kept: false,
      reason: null,
    };

    await pace(new URL(entry.url).host);
    const res = await fetchFeed(entry.url, {});
    record.status = res.status;
    record.ms = res.ms;
    record.contentType = res.type || null;
    if (!res.ok) {
      record.reason = res.reason;
      log(`DEAD ${entry.name} - ${res.reason}`);
      return record;
    }
    record.bytes = res.bytes;

    const items = parseFeedItems(res.text);
    record.items = items.length;
    if (!items.length) {
      record.reason = `HTTP ${res.status} but the body carries no RSS <item> and no Atom <entry>`;
      log(`DEAD ${entry.name} - ${record.reason}`);
      return record;
    }
    record.matchingItems = items.filter((i) =>
      matchItem(`${stripTags(i.title || '')} ${stripTags(i.description || '')}`).ok
    ).length;

    const first = items.map((i) => ({ item: i, url: articleUrl(i.link, entry.url) })).find((x) => x.url);
    if (!first) {
      record.reason = 'no item in the feed carries a usable publisher article URL';
      log(`DEAD ${entry.name} - ${record.reason}`);
      return record;
    }
    record.firstItem = {
      title: tidy(stripTags(first.item.title || ''), 160),
      url: first.url,
      host: new URL(first.url).hostname,
    };

    try {
      record.feedRobots = await robotsVerdict(crawler, entry.url, agent);
    } catch (err) {
      record.feedRobots = { error: `${err.name}: ${err.message}` };
    }
    try {
      record.articleRobots = await robotsVerdict(crawler, first.url, agent);
    } catch (err) {
      record.articleRobots = { error: `${err.name}: ${err.message}` };
    }

    if (opts.articles) {
      const doc = await crawler.fetchDoc(first.url);
      record.article = doc.ok
        ? { ok: true, status: doc.status, kind: doc.kind, chars: doc.text.length, url: doc.url }
        : { ok: false, reason: doc.reason, status: doc.status ?? null, kind: doc.kind ?? null };
    }

    if (record.feedRobots && record.feedRobots.allowed === false) {
      record.reason = `robots.txt disallows the feed path ${record.feedRobots.path} for ${agent}`;
    } else if (!record.articleRobots || record.articleRobots.allowed !== true) {
      record.reason = record.articleRobots && record.articleRobots.error
        ? `could not read robots.txt for the article host: ${record.articleRobots.error}`
        : `robots.txt disallows the article path ${record.articleRobots.path} for ${agent}`;
    } else {
      record.kept = true;
    }

    log(
      `${record.kept ? 'OK  ' : 'DROP'} ${entry.name} - ${record.items} items, ${record.matchingItems} matching, ` +
        `article robots ${record.articleRobots && record.articleRobots.allowed ? 'allow' : 'refuse'}` +
        (record.article ? `, article ${record.article.ok ? `read ${record.article.chars} chars` : `NOT read: ${record.article.reason}`}` : '') +
        (record.kept ? '' : ` (${record.reason})`)
    );
    return record;
  });

  const summary = {
    probed: entries.length,
    answered: entries.filter((e) => e.status === 200).length,
    withItems: entries.filter((e) => e.items > 0).length,
    articleAllowed: entries.filter((e) => e.articleRobots && e.articleRobots.allowed === true).length,
    articleRefused: entries.filter((e) => e.articleRobots && e.articleRobots.allowed === false).length,
    feedRefused: entries.filter((e) => e.feedRobots && e.feedRobots.allowed === false).length,
    kept: entries.filter((e) => e.kept).length,
    dropped: entries.filter((e) => !e.kept).length,
    articlesFetched: entries.filter((e) => e.article && e.article.ok).length,
    articlesNotFetched: entries.filter((e) => e.article && !e.article.ok).length,
    itemsSeen: entries.reduce((n, e) => n + e.items, 0),
    matchingItemsSeen: entries.reduce((n, e) => n + e.matchingItems, 0),
  };

  const bundle = {
    _about:
      'One real probe of every candidate feed. kept=false means the feed did not answer, carried no items, carried no usable article link, or robots.txt refuses us the feed or the article path on this date - those entries were removed from config/publisher-feeds.json and this file is the record of why.',
    probedAt: startedAt,
    finishedAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    articlesFetched: opts.articles,
    summary,
    crawler: crawler.stats(),
    entries,
  };
  await writeFile(opts.out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  process.stderr.write(
    `\n--- feed probe summary ---\n` +
      `probed          ${summary.probed}\n` +
      `HTTP 200        ${summary.answered}\n` +
      `with items      ${summary.withItems} (${summary.itemsSeen} items, ${summary.matchingItemsSeen} matching our keywords)\n` +
      `article robots  ${summary.articleAllowed} allow, ${summary.articleRefused} refuse\n` +
      `feed robots     ${summary.feedRefused} refuse the feed path itself\n` +
      (opts.articles ? `articles        ${summary.articlesFetched} read, ${summary.articlesNotFetched} not read\n` : '') +
      `kept            ${summary.kept}\n` +
      `dropped         ${summary.dropped}\n` +
      `written to      ${path.relative(ROOT, opts.out)}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
