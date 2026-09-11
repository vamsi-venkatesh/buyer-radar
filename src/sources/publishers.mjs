// The openings lane's article supply: publishers' own feeds.
//
// The news lane finds headlines through Google News, and that is where it stops
// being useful. A Google News item links at `news.google.com/rss/articles/<id>`,
// a path Google's own robots.txt refuses to every crawler, and today's ids carry
// no publisher URL to decode. The openings lane obeyed the rule and therefore
// read nothing.
//
// A publisher's own feed has neither problem. The item's link IS the publisher's
// article page, so there is no redirect to follow and nothing to decode, and the
// page is then read under that publisher's own robots.txt like every other page
// this project fetches.
//
// What this source does, and nothing more: fetch the feeds in
// config/publisher-feeds.json - one request every 3 s per host, our own
// User-Agent, the feed only - keep the items whose title or summary talks about
// a requirement or an opening, and emit them as `signal` candidates carrying the
// publisher's direct article URL. It reads no article itself: that is the
// openings lane's job, under the crawler's robots rules.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { PUBLISHERS, USER_AGENT, CITIES, CLIENT } from '../config.mjs';
import { parseFeedItems, stripTags } from '../lib/xml.mjs';
import { mapPool } from '../lib/crawl.mjs';
import { isExcluded, tidy, normaliseName, todayIso, daysBetween } from '../lib/normalise.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'publishers';

// ------------------------------------------------------------------ registry

export async function loadFeeds(file = path.join(ROOT, PUBLISHERS.registry)) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  return entries.filter((e) => e && e.name && e.url);
}

export async function loadProbe(file = path.join(ROOT, PUBLISHERS.probeFile)) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A feed the probe dropped - dead, or one whose article pages robots.txt refuses
 * - is not fetched again on a daily run. The probe file is the record of why.
 */
export function skipFromProbe(entry, probe) {
  if (!probe || !Array.isArray(probe.entries)) return null;
  const record = probe.entries.find((r) => r.url === entry.url || r.name === entry.name);
  if (!record) return null;
  if (record.kept === false) return record.reason || 'the probe recorded no verdict for this feed';
  return null;
}

// ------------------------------------------------------------------ matching
//
// Two rules, and an item has to satisfy one of them whole. A bare "tender" on a
// city desk is a road contract far more often than it is a kitchen, and a bare
// "opens" is a metro line; matching either on its own would fill the register
// with articles nobody will read twice.

// The food-service half is a property of the trade, not of the supplier: a
// canteen is a canteen whoever fills it, and every deployment wants those words.
const FOOD_SERVICE = [
  'vegetable', 'vegetables', 'fresh produce', 'fruits and vegetables',
  'perishable', 'perishables', 'grocery', 'groceries', 'canteen', 'cafeteria',
  'mess', 'hostel', 'kitchen', 'catering', 'caterer', 'caterers', 'diet',
  'midday meal', 'mid-day meal', 'meals', 'food supply',
];

/**
 * The commodity half comes from the client profile, because it is the one thing
 * here that changes with the supplier. A radar run for a dairy has no use for
 * 'garlic' and every use for 'milk', and neither word belongs in the engine.
 *
 * Three places in the profile name what the supplier sells - the catalogue's own
 * labels, the headline commodity's words, and the requirement keywords - and all
 * three are read, because a deployment that fills in only one of them should
 * still get a lane that works.
 */
function clientProduceWords() {
  const words = [
    ...CLIENT.catalogue.items.map((i) => i.label),
    ...(CLIENT.capacity.headlineCommodityWords || []),
    ...(CLIENT.keywords.requirement || []),
  ];
  const seen = new Set();
  const out = [];
  for (const raw of words) {
    const w = String(raw || '').toLowerCase().trim();
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

const PRODUCE = [...FOOD_SERVICE, ...clientProduceWords()];

const PROCUREMENT = [
  'tender', 'tenders', 'e-tender', 'etender', 'bid', 'bids', 'quotation',
  'quotations', 'procure', 'procured', 'procurement', 'supply', 'supplies',
  'supplier', 'suppliers', 'contract', 'contractor', 'rate contract',
  'empanel', 'empanelment', 'outsourced',
];

const OPENING = [
  'open', 'opens', 'opened', 'opening', 'launch', 'launches', 'launched',
  'inaugurate', 'inaugurated', 'inauguration', 'expand', 'expands', 'expanded',
  'expansion', 'unveil', 'unveils', 'set up', 'sets up', 'to come up',
];

const VENUE = [
  'hotel', 'hotels', 'resort', 'resorts', 'restaurant', 'restaurants', 'cafe',
  'eatery', 'bakery', 'food court', 'qsr', 'dining', 'banquet', 'canteen',
  'cafeteria', 'mess', 'hostel', 'kitchen', 'catering', 'supermarket',
  'hypermarket', 'grocery', 'hospital', 'university', 'college', 'campus',
];

/**
 * A word-boundary alternation over a phrase list, longest first.
 *
 * Longest first because alternation takes the first branch that matches: with
 * "vegetable" ahead of "vegetables" every plural item would report the singular,
 * which is a small lie in the receipt about what we actually saw. The word
 * boundaries are not a nicety either - without them "mess" matches inside
 * "message", and this project has already shipped a digest led by three notices
 * called "Director's message".
 */
function phraseRe(list) {
  return new RegExp(
    `\\b(${[...list]
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('|')})\\b`,
    'i'
  );
}

export const PRODUCE_RE = phraseRe(PRODUCE);
export const PROCUREMENT_RE = phraseRe(PROCUREMENT);
export const OPENING_RE = phraseRe(OPENING);
export const VENUE_RE = phraseRe(VENUE);

/**
 * How far apart the two halves of a rule may sit and still be about the same
 * thing, in characters.
 *
 * Two words anywhere in a 600-character summary are not a sentence. "Parul
 * University's theatre festival opens" matched "university" and "opens" on the
 * first pass and was neither an opening nor a buyer; the words were forty words
 * apart and belonged to different clauses. A gap is a crude proxy for a clause,
 * and a crude proxy that drops that item is worth more than none.
 */
export const NEAR = { demand: 140, opening: 90 };

function every(re, text) {
  const all = new RegExp(re.source, 'gi');
  const out = [];
  for (const m of String(text).matchAll(all)) {
    out.push({ word: m[1].toLowerCase().replace(/\s+/g, ' '), at: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The closest pair of matches from the two lists, or null when none are near. */
function nearestPair(a, b, maxGap) {
  let best = null;
  for (const x of a) {
    for (const y of b) {
      const gap = x.at <= y.at ? y.at - x.end : x.at - y.end;
      if (gap > maxGap) continue;
      if (!best || gap < best.gap) best = { gap: Math.max(0, gap), first: x, second: y };
    }
  }
  return best;
}

/**
 * Does this headline and summary say something the owner could sell into?
 *
 * Returns `{ ok, rule, keywords, gap }`. `rule` is 'demand' when somebody is
 * buying food - a produce or food-service word next to a procurement word - and
 * 'opening' when a place that will need vegetables is being opened or expanded.
 * Next to is literal: the two words have to sit within NEAR characters of each
 * other, or they are two words in one summary rather than one statement. The
 * words that matched and the gap between them are carried, so the receipt can
 * say why this item was kept.
 */
export function matchItem(text) {
  const s = String(text || '');
  if (!s.trim()) return { ok: false, rule: null, keywords: [] };
  if (isExcluded(s)) return { ok: false, rule: null, keywords: [], reason: 'excluded operating model' };

  const demand = nearestPair(every(PRODUCE_RE, s), every(PROCUREMENT_RE, s), NEAR.demand);
  if (demand) {
    return { ok: true, rule: 'demand', keywords: [demand.first.word, demand.second.word], gap: demand.gap };
  }

  const opening = nearestPair(every(OPENING_RE, s), every(VENUE_RE, s), NEAR.opening);
  if (opening) {
    return { ok: true, rule: 'opening', keywords: [opening.first.word, opening.second.word], gap: opening.gap };
  }

  return { ok: false, rule: null, keywords: [] };
}

const SEGMENT_RULES = [
  [/\b(hotels?|resorts?)\b/i, 'hotel'],
  [/\b(restaurants?|cafe|eatery|bakery|food court|qsr|dining)\b/i, 'restaurant'],
  [/\b(canteen|cafeteria|mess|hostel|hospital|university|college|campus|midday meal|mid-day meal|diet)\b/i, 'institution'],
  [/\b(supermarket|hypermarket|grocery|groceries)\b/i, 'retailer'],
  [/\b(catering|caterers?|banquet)\b/i, 'caterer'],
  [/\b(wholesale|mandi|apmc)\b/i, 'wholesale'],
  [/\b(food processing|processing unit|manufactur\w*)\b/i, 'food_manufacturer'],
];

/** The segment the item's own words support, or 'other'. Never a guess from the feed. */
export function segmentFor(text) {
  const rule = SEGMENT_RULES.find((r) => r[0].test(String(text || '')));
  return rule ? rule[1] : 'other';
}

// Every name a city answers to, mapped back to the city itself. A newspaper
// writes "Bangalore" as often as "Bengaluru" and neither spelling is wrong, so
// the client profile may list a city's other names in `aliases` - matching only
// the display name would drop half a city desk's items without saying so.
const CITY_NAMES = new Map();
for (const city of Object.values(CITIES)) {
  for (const name of [city.name, ...(city.aliases || [])]) {
    const key = String(name || '').toLowerCase().trim();
    if (key) CITY_NAMES.set(key, city);
  }
}

const CITY_RE = new RegExp(
  `\\b(${[...CITY_NAMES.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|')})\\b`,
  'i'
);

/** The city the item names, matched against the cities this project covers. */
export function cityNamed(text) {
  const m = CITY_RE.exec(String(text || ''));
  if (!m) return null;
  return CITY_NAMES.get(m[1].toLowerCase().replace(/\s+/g, ' ')) || null;
}

// --------------------------------------------------------------------- links

const TRACKING = /^(utm_|fbclid$|gclid$|igshid$|ref$|ref_src$|at_medium$|at_campaign$)/i;

/** An aggregator's redirect is not a publisher's article, whatever the feed says. */
export const AGGREGATOR_HOSTS = [
  'news.google.com',
  'google.com',
  'www.google.com',
  'feedproxy.google.com',
  'news.yahoo.com',
  'flipboard.com',
];

/**
 * The article URL as it should be stored: absolute, http(s), no tracking
 * parameters, and never an aggregator's redirect. Returns null when the item
 * carries nothing we can point the crawler at.
 */
export function articleUrl(rawLink, feedUrl) {
  if (!rawLink) return null;
  let url;
  try {
    url = new URL(String(rawLink).trim(), feedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (AGGREGATOR_HOSTS.includes(url.hostname.toLowerCase())) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

function isoDate(pubDate) {
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ the feed

/**
 * Read one feed into candidates.
 *
 * RSS and Atom both, because a publisher's feed is whichever of the two that
 * publisher chose. An item is kept when its title or summary matches, when its
 * link is the publisher's own article page, and when it is recent enough to act
 * on - an item from last spring is history, not a lead.
 */
export function parseFeed(
  xml,
  { entry, todayIsoDate = todayIso(), maxAgeDays = PUBLISHERS.maxItemAgeDays, max = PUBLISHERS.maxPerFeed } = {}
) {
  const out = [];
  const seen = new Set();
  const stats = { items: 0, kept: 0, unmatched: 0, stale: 0, unusableLink: 0 };

  for (const item of parseFeedItems(xml)) {
    stats.items += 1;
    const title = tidy(stripTags(item.title || ''), 200);
    if (!title) continue;
    const description = tidy(stripTags(item.description || ''), 600);
    const match = matchItem(`${title} ${description}`);
    if (!match.ok) {
      stats.unmatched += 1;
      continue;
    }
    const url = articleUrl(item.link, entry.url);
    if (!url) {
      stats.unusableLink += 1;
      continue;
    }
    const date = isoDate(item.pubDate);
    if (date && maxAgeDays != null) {
      const age = daysBetween(date, todayIsoDate);
      if (age !== null && age > maxAgeDays) {
        stats.stale += 1;
        continue;
      }
    }
    if (seen.has(url)) continue;
    seen.add(url);

    const named = cityNamed(`${title} ${description}`);
    const city = named || (entry.city ? { name: entry.city, state: entry.state || null } : null);
    out.push({
      kind: 'signal',
      segment: segmentFor(`${title} ${description}`),
      name: title,
      city: city ? city.name : null,
      state: city ? city.state || null : null,
      address: null,
      phone: null,
      email: null,
      website: null,
      whyNow: date ? `reported ${date}` : 'recent article',
      whyNowDate: date,
      source: name,
      sourceUrl: url,
      licence: PUBLISHERS.licence,
      externalId: sha256Hex(url).slice(0, 24),
      extra: {
        feed: entry.name,
        feedUrl: entry.url,
        publication: entry.publisher || entry.name,
        publisher: new URL(url).hostname,
        feedCategory: entry.category || null,
        matchedKeyword: match.keywords.join(' + '),
        matchRule: match.rule,
        matchGap: match.gap ?? null,
        cityFrom: named ? 'the article names it' : entry.city ? 'the feed is that city desk' : null,
        summary: description || null,
        publishedAt: item.pubDate || null,
      },
    });
    if (out.length >= max) break;
  }

  stats.kept = out.length;
  return { candidates: out, stats };
}

// --------------------------------------------------------------------- dedup

/**
 * Drop the items the news lane already found.
 *
 * The same hotel opening reaches us twice: once as a Google News headline and
 * once from the publisher's own feed. They are one lead, and the news lane runs
 * first and already holds the signal, so the duplicate is dropped here rather
 * than merged later. Matched on the normalised title, because the two differ in
 * punctuation and in Google's " - Publication" suffix but not in the words.
 */
export function dedupeAgainstNews(candidates, others = []) {
  const taken = new Set();
  for (const o of others) {
    if (!o) continue;
    const key = normaliseName(o.name);
    if (key) taken.add(key);
  }
  const kept = [];
  const dropped = [];
  const mine = new Set();
  for (const c of candidates) {
    const key = normaliseName(c.name);
    if (key && taken.has(key)) {
      dropped.push({ name: c.name, url: c.sourceUrl, reason: 'the news lane already holds this headline' });
      continue;
    }
    if (key && mine.has(key)) {
      dropped.push({ name: c.name, url: c.sourceUrl, reason: 'another feed in this run carries the same headline' });
      continue;
    }
    if (key) mine.add(key);
    kept.push(c);
  }
  return { kept, dropped };
}

// --------------------------------------------------------------------- fetch

/** One feed request: our User-Agent, a real deadline, and a byte cap. */
export async function fetchFeed(
  url,
  {
    fetchImpl = globalThis.fetch,
    userAgent = USER_AGENT,
    timeoutMs = PUBLISHERS.httpTimeoutMs,
    maxBytes = PUBLISHERS.maxBytes,
  } = {}
) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });
    const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
      return { ok: false, status: res.status, url: res.url || url, type, ms: Date.now() - startedAt, reason: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, maxBytes).toString('utf8');
    return {
      ok: true,
      status: res.status,
      url: res.url || url,
      type,
      bytes: buf.length,
      truncated: buf.length > maxBytes,
      text,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    return { ok: false, status: null, url, ms: Date.now() - startedAt, reason: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** One request every `pauseMs` per host, whoever asks. */
export function createPacer({
  pauseMs = PUBLISHERS.pauseMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const lastAt = new Map();
  return async (host) => {
    const last = lastAt.get(host);
    if (last !== undefined) {
      const wait = pauseMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastAt.set(host, now());
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/**
 * Fetch every feed this city's run should read.
 *
 * A feed belonging to another city's desk is not fetched at all: a Bengaluru run
 * has no use for a Chennai city desk, and not fetching it is politer than
 * fetching it and throwing the items away. National, trade and institutional
 * feeds carry no city and are always read.
 */
export async function fetch(ctx) {
  const { city, log = () => {}, fetchImpl = globalThis.fetch, todayIsoDate = todayIso(), soFar = [] } = ctx;
  const all = await loadFeeds();
  const probe = await loadProbe();
  const pace = createPacer();

  const planned = [];
  const skipped = [];
  for (const entry of all) {
    const dead = skipFromProbe(entry, probe);
    if (dead) {
      skipped.push({ feed: entry.name, reason: `the probe dropped this feed: ${dead}` });
      continue;
    }
    if (entry.city && city && entry.city.toLowerCase() !== city.name.toLowerCase()) {
      skipped.push({ feed: entry.name, reason: `a ${entry.city} desk, and this run is for ${city.name}` });
      continue;
    }
    planned.push(entry);
  }

  const results = await mapPool(planned, PUBLISHERS.concurrency, async (entry) => {
    await pace(hostOf(entry.url));
    const res = await fetchFeed(entry.url, { fetchImpl });
    if (!res.ok) {
      log(`publishers: ${entry.name} FAILED ${res.reason}`);
      return { entry, failed: res.reason, status: res.status ?? null, candidates: [], stats: null, ms: res.ms };
    }
    const parsed = parseFeed(res.text, { entry, todayIsoDate });
    log(`publishers: ${entry.name} items=${parsed.stats.items} kept=${parsed.stats.kept} (${res.ms} ms)`);
    return { entry, failed: null, status: res.status, candidates: parsed.candidates, stats: parsed.stats, ms: res.ms };
  });

  const raw = results.flatMap((r) => r.candidates);
  const { kept, dropped } = dedupeAgainstNews(raw, soFar);

  const feeds = results.map((r) => ({
    feed: r.entry.name,
    url: r.entry.url,
    status: r.status,
    items: r.stats ? r.stats.items : 0,
    kept: r.stats ? r.stats.kept : 0,
    stale: r.stats ? r.stats.stale : 0,
    failed: r.failed,
    ms: r.ms ?? null,
  }));

  const detail = {
    feedsConfigured: all.length,
    feedsFetched: planned.length,
    feedsSkipped: skipped.length,
    feedsFailed: feeds.filter((f) => f.failed).length,
    itemsSeen: feeds.reduce((n, f) => n + f.items, 0),
    itemsMatched: raw.length,
    duplicatesDropped: dropped.length,
    candidates: kept.length,
    skipped,
    dropped,
    feeds,
  };

  const failed = feeds.filter((f) => f.failed);
  const blocked =
    planned.length && failed.length === planned.length
      ? {
          source: name,
          reason: `every one of the ${planned.length} feeds this run reads failed: ${failed[0].failed}`,
          kind: 'http',
        }
      : null;

  return { candidates: kept, detail, ...(blocked ? { blocked } : {}) };
}
