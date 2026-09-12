// The publisher-feed lane: where the openings lane's articles come from.
//
// The fixtures under test/fixtures/publishers-* are real. Three feeds were
// fetched from their publishers on 2026-09-11 and trimmed to their first items
// plus every item that matched, and two article pages were fetched through the
// same crawler the daily run uses, under those publishers' own robots.txt. No
// model is called anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as publishers from '../src/sources/publishers.mjs';
import * as openings from '../src/sources/openings.mjs';
import { parseFeedItems, parseAtomEntries } from '../src/lib/xml.mjs';
import { createCrawler } from '../src/lib/crawl.mjs';
import { htmlToText } from '../src/llm/page.mjs';
import * as news from '../src/sources/news.mjs';
import { OPENINGS, CITIES, openingsMaxReads } from '../src/config.mjs';
import { loadProfile } from '../src/lib/profile.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => readFile(path.join(FIXTURES, f), 'utf8');

const TELANGANA = { name: 'Telangana Today', publisher: 'Telangana Today', url: 'https://telanganatoday.com/feed', category: 'city_desk', city: 'Hyderabad', state: 'Telangana' };
const ET_FOOD = { name: 'The Economic Times - Food and Consumer Products', publisher: 'The Economic Times', url: 'https://economictimes.indiatimes.com/industry/cons-products/food/rssfeeds/13358050.cms', category: 'agri_trade', city: null, state: null };
const ET_HOSPITALITY = { name: 'ET HospitalityWorld', publisher: 'The Economic Times', url: 'https://hospitality.economictimes.indiatimes.com/rss/topstories', category: 'hospitality_trade', city: null, state: null };

// ------------------------------------------------------------- the registry

test('every configured feed is a direct publisher URL, and the probe kept it', async () => {
  const feeds = await publishers.loadFeeds();
  const probe = await publishers.loadProbe();
  assert.ok(feeds.length >= 25, `${feeds.length} feeds configured`);
  assert.ok(probe && Array.isArray(probe.entries), 'the probe file is there to be read');
  for (const feed of feeds) {
    const url = new URL(feed.url);
    assert.equal(url.protocol, 'https:', feed.name);
    assert.ok(!publishers.AGGREGATOR_HOSTS.includes(url.hostname), `${feed.name} is not an aggregator`);
    assert.equal(publishers.skipFromProbe(feed, probe), null, `${feed.name} was kept by the probe`);
    const record = probe.entries.find((r) => r.url === feed.url);
    assert.ok(record && record.kept, `${feed.name} has a kept probe record`);
    assert.equal(record.articleRobots.allowed, true, `${feed.name}: robots.txt allows the article path`);
  }
  const dropped = probe.entries.filter((r) => !r.kept);
  for (const r of dropped) {
    assert.ok(r.reason, `${r.name} was dropped with a reason`);
    assert.ok(!feeds.some((f) => f.url === r.url), `${r.name} is not in the live list`);
  }
});

// ------------------------------------------------------------ reading a feed

test('REAL: a city desk feed parses into signals with the publisher\'s own article URL', async () => {
  const { candidates, stats } = publishers.parseFeed(await read('publishers-feed-telangana-today.xml'), {
    entry: TELANGANA,
    maxAgeDays: null,
  });
  assert.ok(stats.items >= 5, `${stats.items} items in the fixture`);
  assert.ok(candidates.length >= 1, 'at least one item talks about an opening');
  for (const c of candidates) {
    assert.equal(c.kind, 'signal');
    assert.equal(c.source, 'publishers');
    assert.equal(new URL(c.sourceUrl).hostname, 'telanganatoday.com', 'the link is the publisher, not a redirect');
    assert.equal(c.phone, null);
    assert.equal(c.email, null);
    assert.ok(c.extra.matchedKeyword.includes(' + '), 'the receipt says which two words matched');
    assert.equal(c.extra.feedUrl, TELANGANA.url);
    assert.equal(c.extra.publisher, 'telanganatoday.com');
  }
  const restaurant = candidates.find((c) => /Anaganaga/i.test(c.name));
  assert.ok(restaurant, 'the new Jubilee Hills restaurant is in the fixture');
  assert.equal(restaurant.segment, 'restaurant');
  assert.equal(restaurant.city, 'Hyderabad');
  assert.equal(restaurant.extra.matchRule, 'opening');
});

test('REAL: a trade feed parses the same way', async () => {
  const hospitality = publishers.parseFeed(await read('publishers-feed-et-hospitalityworld.xml'), { entry: ET_HOSPITALITY, maxAgeDays: null });
  const chalet = hospitality.candidates.find((c) => /Chalet Hotels/i.test(c.name));
  assert.ok(chalet, 'a hotel group stating an expansion is kept');
  assert.equal(chalet.segment, 'hotel');
  assert.equal(chalet.extra.matchRule, 'opening');
  assert.equal(new URL(chalet.sourceUrl).hostname, 'hospitality.economictimes.indiatimes.com');

  const food = publishers.parseFeed(await read('publishers-feed-the-economic-times-food-and-consumer-products.xml'), { entry: ET_FOOD, maxAgeDays: null });
  assert.ok(food.candidates.length >= 1, `${food.candidates.length} kept from the food desk`);
  assert.ok(food.candidates.every((c) => c.extra.publication === 'The Economic Times'));
});

test('an Atom feed is read too - the link is an attribute, not the element body', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Campus notices</title>
  <link rel="self" href="https://college.example/feed.atom"/>
  <entry>
    <title>Tender for supply of vegetables to the hostel mess</title>
    <link rel="alternate" href="https://college.example/notices/veg-tender"/>
    <link rel="edit" href="https://college.example/edit/1"/>
    <id>tag:college.example,2026:1</id>
    <published>2026-09-10T06:00:00Z</published>
    <summary>Quotations are invited for the supply of fresh vegetables.</summary>
  </entry>
</feed>`;
  const entries = parseAtomEntries(atom);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].link, 'https://college.example/notices/veg-tender', 'rel=self is the feed, not the article');
  assert.deepEqual(parseFeedItems(atom).map((e) => e.link), [entries[0].link]);

  const { candidates } = publishers.parseFeed(atom, {
    entry: { name: 'Campus notices', url: 'https://college.example/feed.atom', category: 'institution', city: 'Bengaluru', state: 'Karnataka' },
    todayIsoDate: '2026-09-11',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].extra.matchRule, 'demand');
  assert.equal(candidates[0].segment, 'institution');
  assert.equal(candidates[0].whyNowDate, '2026-09-10');
});

test('an item older than the age cap is history, not a lead', () => {
  const rss = `<rss><channel><item>
    <title>Canteen tender floated for the staff mess</title>
    <link>https://paper.example/old-canteen-tender</link>
    <pubDate>Mon, 01 Jan 2026 06:00:00 +0530</pubDate>
  </item></channel></rss>`;
  const entry = { name: 'Paper', url: 'https://paper.example/feed' };
  assert.equal(publishers.parseFeed(rss, { entry, todayIsoDate: '2026-09-11' }).candidates.length, 0);
  assert.equal(publishers.parseFeed(rss, { entry, todayIsoDate: '2026-01-03' }).candidates.length, 1);
});

// ---------------------------------------------------------- the keyword filter

test('the keyword filter keeps buyers and openings, and nothing else', () => {
  const kept = [
    ['Tender floated for supply of vegetables to the hostel mess', 'demand'],
    ['Quotations invited for canteen provisions at the district hospital', 'demand'],
    ['Corporation invites bids for mid-day meal groceries', 'demand'],
    ['Taj to open a 200-room hotel in Whitefield next year', 'opening'],
    ['ITC expands its Bengaluru hotel portfolio', 'opening'],
    ['New restaurant opens in Jubilee Hills', 'opening'],
  ];
  for (const [text, rule] of kept) {
    const m = publishers.matchItem(text);
    assert.equal(m.ok, true, text);
    assert.equal(m.rule, rule, text);
    assert.equal(m.keywords.length, 2, text);
  }

  for (const text of [
    'Metro line opens between Majestic and Whitefield',
    'Cricket match report: city eleven wins by four wickets',
    'Tender floated for resurfacing the outer ring road',
    'Minister launches new housing scheme',
    '',
  ]) {
    assert.equal(publishers.matchItem(text).ok, false, text);
  }
});

test('two words in one summary are not one statement', () => {
  const near = 'The university inaugurated a new hostel mess block this week.';
  assert.equal(publishers.matchItem(near).ok, true);

  const far =
    'The theatre festival was inaugurated on Tuesday evening. ' +
    'Performances ran late into the night and the troupes travelled from six states. '.repeat(3) +
    ' The organisers said the university would host it again.';
  const m = publishers.matchItem(far);
  assert.equal(m.ok, false, 'the two words are a couple of hundred characters and several clauses apart');
});

test('the operating model this project does not target is filtered out here as well', () => {
  assert.equal(publishers.matchItem('New cloud kitchen opens in Indiranagar with 20 brands').ok, false);
});

test('a segment is only what the words support', () => {
  assert.equal(publishers.segmentFor('Marriott opens a 200-room hotel'), 'hotel');
  assert.equal(publishers.segmentFor('Hostel mess tender at the medical college'), 'institution');
  assert.equal(publishers.segmentFor('Something else entirely'), 'other');
});

// ------------------------------------------------------------------- links

test('an article URL is the publisher\'s, cleaned, and never an aggregator\'s', () => {
  assert.equal(
    publishers.articleUrl('https://paper.example/story?utm_source=rss&utm_medium=feed&id=7', 'https://paper.example/feed'),
    'https://paper.example/story?id=7'
  );
  assert.equal(publishers.articleUrl('/city/story', 'https://paper.example/feed'), 'https://paper.example/city/story');
  assert.equal(publishers.articleUrl('https://news.google.com/rss/articles/AU_yqL', 'https://paper.example/feed'), null);
  assert.equal(publishers.articleUrl('javascript:void(0)', 'https://paper.example/feed'), null);
  assert.equal(publishers.articleUrl('', 'https://paper.example/feed'), null);
});

// ------------------------------------------------------------------- dedup

test('a headline the news lane already holds is dropped, not merged later', () => {
  const news = [{ name: 'Taj Hotels opens a new property in Whitefield', source: 'news' }];
  const mine = [
    { name: 'Taj Hotels opens a new property in Whitefield.', sourceUrl: 'https://paper.example/a' },
    { name: 'Corporation invites bids for mid-day meal groceries', sourceUrl: 'https://paper.example/c' },
    { name: 'CORPORATION INVITES BIDS FOR MID-DAY MEAL GROCERIES', sourceUrl: 'https://other.example/d' },
  ];
  const { kept, dropped } = publishers.dedupeAgainstNews(mine, news);
  assert.deepEqual(kept.map((c) => c.sourceUrl), ['https://paper.example/c']);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].reason, /news lane already holds/);
  assert.match(dropped[1].reason, /another feed in this run/);
});

test('with nothing to compare against, nothing is dropped', () => {
  const mine = [{ name: 'A tender for vegetables', sourceUrl: 'https://a/1' }];
  assert.equal(publishers.dedupeAgainstNews(mine).kept.length, 1);
});

// ---------------------------------------------------------------- the fetch

test('the feeds are fetched one host at a time, with our own User-Agent', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, ua: init.headers['User-Agent'] });
    return new Response('<rss><channel></channel></rss>', { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  };
  const res = await publishers.fetchFeed('https://paper.example/feed', { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.match(seen[0].ua, /^BuyerRadar\//);

  const waits = [];
  const pace = publishers.createPacer({ pauseMs: 3000, now: () => 1000, sleep: async (ms) => waits.push(ms) });
  await pace('paper.example');
  await pace('paper.example');
  await pace('other.example');
  assert.deepEqual(waits, [3000], 'the second request to one host waits; a different host does not');
});

test('a feed that will not answer is a recorded failure, not an exception', async () => {
  const res = await publishers.fetchFeed('https://paper.example/feed', {
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /TypeError: fetch failed/);
});

// --------------------------------------------- into the openings lane

const leadFrom = (candidate, id) => ({
  id,
  kind: 'signal',
  source: candidate.source,
  source_url: candidate.sourceUrl,
  name: candidate.name,
  city: candidate.city,
  score: 40,
  why_now: candidate.whyNow,
  extra: { ...candidate.extra },
});

test('the openings lane picks up a publisher signal as readily as a news one', () => {
  const make = (id, source, name) => ({ id, kind: 'signal', source, source_url: `https://p/${id}`, name, score: 40, extra: {} });
  const chosen = openings.selectSignals(
    [
      make('a', 'publishers', 'Taj to open a 200-room hotel in Whitefield'),
      make('b', 'news', 'Canteen tender floated by the railway'),
      make('c', 'overpass', 'Sri Venkateshwara Traders'),
      make('d', 'publishers', 'Cricket match report'),
    ],
    { limit: 10, promptVersion: 'v1' }
  );
  // Requirement candidates first - 'b' is a posted tender - then awareness.
  assert.deepEqual(chosen.map((l) => l.id), ['b', 'a']);
  assert.equal(openings.tierOf(chosen[0]), 'requirement_candidate');
  assert.equal(openings.tierOf(chosen[1]), 'awareness');
  assert.ok(OPENINGS.signalSources.includes('publishers'));

  // The budget goes to the links that can be read. A Google News item scoring
  // higher does not take a slot from a publisher item that is already an
  // article: today every Google id is the opaque form, and those resolve to
  // nothing.
  const google = (id, score) => ({
    id,
    kind: 'signal',
    source: 'news',
    source_url: `https://news.google.com/rss/articles/AU_yqL${id}?oc=5`,
    name: 'Canteen tender floated',
    score,
    extra: {},
  });
  const order = openings.selectSignals(
    [
      google('g1', 99),
      { ...make('p1', 'publishers', 'Tender floated for supply of vegetables to the hostel mess'), score: 10 },
      google('g2', 98),
    ],
    { limit: 2, promptVersion: 'v1' }
  );
  assert.deepEqual(order.map((l) => l.id), ['p1', 'g1']);
});

test('REAL: an expansion story is kept as an awareness signal - no article fetched, no model called', async () => {
  const { candidates } = publishers.parseFeed(await read('publishers-feed-et-hospitalityworld.xml'), { entry: ET_HOSPITALITY, maxAgeDays: null });
  const candidate = candidates.find((c) => /Chalet Hotels/i.test(c.name));
  assert.ok(candidate, 'the fixture carries the item whose page was saved');
  assert.equal(candidate.extra.matchTier, 'awareness', 'an expansion is awareness, not a posted requirement');
  const lead = leadFrom(candidate, 'l1');

  const receipts = [];
  const out = await openings.upgradeSignals([lead], {
    runner: {
      notNeeded() { throw new Error('an awareness signal never reaches the model gate'); },
      ask: async () => { throw new Error('no model call belongs on an awareness signal'); },
    },
    crawler: {
      robotsFor: async () => { throw new Error('no robots.txt is read for an article we are not going to fetch'); },
      fetchDoc: async (url) => { throw new Error(`no article fetch belongs here: ${url}`); },
    },
    chain: { add: (type, data) => receipts.push({ type, data }) },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs on an awareness signal'); },
  });

  assert.equal(out.considered, 1);
  assert.equal(out.requirementCandidates, 0);
  assert.equal(out.awarenessOnly, 1);
  assert.equal(out.articlesRead, 0);
  assert.equal(out.upgraded, 0);

  assert.equal(lead.kind, 'signal', 'it stays a signal, and it is still a lead worth keeping');
  assert.ok(lead.why_now, 'an awareness signal keeps a reason to act on it');
  assert.match(lead.why_now, /opening or expansion reported/);
  assert.equal(lead.extra.awarenessOnly, true);

  const receipt = receipts.find((r) => r.type === 'openings.awareness_only');
  assert.ok(receipt, 'the decision not to spend is on the receipt chain');
  assert.equal(receipt.data.leadId, 'l1');
  assert.equal(receipt.data.matchRule, 'opening');
});

test('a publisher item that does state a requirement is read end to end, model and all', async () => {
  const rss = `<rss><channel><item>
    <title>Tender floated for supply of vegetables to the hostel mess</title>
    <description>The university has invited quotations for the annual supply of fresh vegetables to its hostel mess.</description>
    <link>https://paper.example/city/hostel-mess-tender</link>
    <pubDate>Wed, 10 Sep 2026 06:00:00 +0530</pubDate>
  </item></channel></rss>`;
  const entry = { name: 'Paper', publisher: 'Paper', url: 'https://paper.example/feed', city: 'Bengaluru', state: 'Karnataka' };
  const { candidates } = publishers.parseFeed(rss, { entry, todayIsoDate: '2026-09-11' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].extra.matchTier, 'requirement_candidate');
  const lead = leadFrom(candidates[0], 'l3');

  const article =
    '<html><body><p>The university has invited quotations for the annual supply of fresh vegetables ' +
    'to its hostel mess. Bids close on 30 September 2026.</p>' +
    '<a href="https://hostelmess.example">Sunrise University</a></body></html>';
  const site = '<html><body><p>Sunrise University. Purchase Officer: Shri A Rao. Phone: 080-2293 2222</p></body></html>';

  const fetched = [];
  const crawler = {
    robotsFor: async () => { throw new Error('a publisher URL is already the article - nothing to resolve through Google'); },
    fetchDoc: async (url) => {
      fetched.push(url);
      if (url === candidates[0].sourceUrl) return { ok: true, url, html: article, text: article.replace(/<[^>]+>/g, ' '), status: 200, kind: 'html' };
      if (url.startsWith('https://hostelmess.example')) return { ok: true, url, html: site, text: site.replace(/<[^>]+>/g, ' '), status: 200, kind: 'html' };
      return { ok: false, reason: 'HTTP 404', url };
    },
  };
  let asked = 0;
  const receipts = [];
  const out = await openings.upgradeSignals([lead], {
    runner: {
      notNeeded: ({ reason }) => { throw new Error(`the model is needed here: ${reason}`); },
      ask: async ({ input }) => {
        asked += 1;
        assert.match(input, /Article text:/);
        return {
          ok: true,
          value: {
            isRequirement: true,
            organisation: 'Sunrise University',
            requirement: 'annual supply of fresh vegetables to the hostel mess',
            quantity: null,
            deadline: '2026-09-30',
            contactHint: null,
            site: 'https://hostelmess.example',
            evidence: ['invited quotations for the annual supply of fresh vegetables'],
            confidence: 0.9,
          },
        };
      },
    },
    crawler,
    chain: { add: (type, data) => receipts.push({ type, data }) },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs in this lane for a direct publisher URL'); },
  });

  assert.equal(out.requirementCandidates, 1);
  assert.equal(out.awarenessOnly, 0);
  assert.equal(out.articlesRead, 1);
  assert.equal(asked, 1);
  assert.equal(fetched[0], candidates[0].sourceUrl);
  assert.equal(lead.kind, 'requirement');
  assert.equal(lead.phone, '+918022932222');
  assert.equal(lead.extra.organisation, 'Sunrise University');
  assert.ok(receipts.some((r) => r.type === 'openings.article_read'));
  assert.ok(receipts.some((r) => r.type === 'openings.upgraded'));
});

test('REAL: a phone number on a newspaper page is the newspaper\'s, and is never the buyer\'s contact', async () => {
  const html = await read('publishers-article-telanganatoday.html');
  const { candidates } = publishers.parseFeed(await read('publishers-feed-telangana-today.xml'), { entry: TELANGANA, maxAgeDays: null });
  const candidate = candidates.find((c) => /Loyola Academy/i.test(c.name));
  assert.ok(candidate);
  assert.equal(candidate.extra.matchTier, 'awareness');

  // The deterministic readers do get something off this page - a date - and the
  // oldest version of this lane would have stopped there and used whatever
  // contact the page carried. The page belongs to Telangana Today.
  const text = htmlToText(html, { maxChars: 20000 });
  assert.ok(openings.deterministicReads(text, { todayIsoDate: '2026-09-11' }).deadline, 'a date is readable on the page');

  // First: as awareness, the page is never fetched at all.
  const lead = leadFrom(candidate, 'l2');
  const untouched = await openings.upgradeSignals([lead], {
    runner: {
      notNeeded() { throw new Error('an awareness signal never reaches the model gate'); },
      ask: async () => { throw new Error('no model call belongs on an awareness signal'); },
    },
    crawler: {
      robotsFor: async () => { throw new Error('no robots.txt read belongs here'); },
      fetchDoc: async (url) => { throw new Error(`no fetch belongs here: ${url}`); },
    },
    chain: { add() {} },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs here'); },
  });
  assert.equal(untouched.awarenessOnly, 1);
  assert.equal(untouched.articlesRead, 0);
  assert.equal(lead.kind, 'signal');
  assert.ok(!lead.phone, 'no number was written onto the lead');

  // Second, with the tier forced to a requirement candidate, so the rules below
  // the tier are still exercised on a REAL newspaper page: the article never
  // uses procurement wording, so the pre-check refuses the model, and no
  // contact is taken off the newspaper whatever its page carries.
  const forced = leadFrom(candidate, 'l2b');
  forced.extra.matchTier = 'requirement_candidate';
  const fetched = [];
  const refusals = [];
  const out = await openings.upgradeSignals([forced], {
    runner: {
      notNeeded: (r) => refusals.push(r),
      ask: async () => { throw new Error('this page never says tender, supply or empanelment - the model must not be called'); },
    },
    crawler: {
      robotsFor: async () => { throw new Error('no Google robots.txt read belongs here'); },
      fetchDoc: async (url) => {
        fetched.push(url);
        return { ok: true, url, html, text, status: 200, kind: 'html' };
      },
    },
    chain: { add() {} },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs here'); },
  });

  assert.equal(out.articlesRead, 1);
  assert.equal(out.notNeeded, 1);
  assert.equal(out.upgraded, 0);
  assert.deepEqual(refusals.map((r) => r.reason), ['no procurement wording']);
  assert.deepEqual(fetched, [candidate.sourceUrl], 'the newspaper is read once as an article and never as a buyer\'s site');
  assert.equal(forced.kind, 'signal');
  assert.ok(!forced.phone, 'no number was written onto the lead');
  assert.equal(forced.extra.contactComplete, false);
  assert.equal(forced.extra.contactNotFound, 'no procurement wording');
});

test('REAL: a second publisher\'s page reads as text through the same crawler path', async () => {
  const html = await read('publishers-article-hospitality.html');
  const text = htmlToText(html, { maxChars: 20000 });
  assert.match(text, /Chalet Hotels/i);
  const found = openings.deterministicReads(text, { todayIsoDate: '2026-09-11' });
  assert.equal(found.contacts.complete, false, 'a news article publishes no purchase contact, and we do not invent one');
});

test('a publisher whose robots.txt refuses the article is skipped, with the refusal recorded', async () => {
  const crawler = createCrawler({
    perHostPauseMs: 0,
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new Error(`the crawler fetched ${url} after robots.txt refused it`);
    },
  });
  const lead = {
    id: 'l9',
    kind: 'signal',
    source: 'publishers',
    source_url: 'https://walled.example/city/hostel-mess-tender',
    name: 'Tender floated for supply of vegetables to the hostel mess',
    city: 'Bengaluru',
    score: 40,
    extra: {},
  };
  const receipts = [];
  const out = await openings.upgradeSignals([lead], {
    runner: { notNeeded() {}, ask: async () => { throw new Error('no model call belongs here'); } },
    crawler,
    chain: { add: (type, data) => receipts.push({ type, data }) },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no resolver call belongs here'); },
  });
  assert.equal(out.articlesRead, 0);
  assert.equal(out.articlesSkipped, 1);
  assert.equal(lead.kind, 'signal', 'a page we may not read leaves the lead exactly as it was');
  const skipped = receipts.find((r) => r.type === 'openings.article_skipped');
  assert.ok(skipped, 'the refusal is on the receipt chain');
  assert.match(skipped.data.reason, /robots\.txt disallows \/city\/hostel-mess-tender/);
  assert.equal(crawler.stats().blockedByRobots, 1);
});

// ------------------------------------------------------------------- tiers
//
// The first real run of this lane on the server read 12 articles, made 34 model
// calls and spent Rs 8.57 to learn that 0 of them stated a requirement. Every
// one was an opening or an expansion story. The tiers are that run's lesson:
// awareness is kept and never paid for.

test('the two tiers are decided by the configured word lists, not by the code', () => {
  for (const text of [
    'Tender floated for supply of vegetables to the hostel mess',
    'Quotations invited for canteen provisions at the district hospital',
    'EOI invited for the annual supply of fresh vegetables to the college mess',
    'Vendor registration opens for hostel kitchen supplies',
    'RFQ issued for mid-day meal groceries',
  ]) {
    const m = publishers.matchItem(text);
    assert.equal(m.ok, true, text);
    assert.equal(m.tier, 'requirement_candidate', text);
    assert.equal(m.rule, 'demand', text);
  }

  for (const text of [
    'Taj to open a 200-room hotel in Whitefield next year',
    'ITC expands its Bengaluru hotel portfolio',
    'New restaurant opens in Jubilee Hills',
  ]) {
    const m = publishers.matchItem(text);
    assert.equal(m.ok, true, text);
    assert.equal(m.tier, 'awareness', text);
    assert.equal(m.rule, 'opening', text);
  }

  assert.equal(publishers.matchItem('Metro line opens between Majestic and Whitefield').tier, null);

  // The lists are built at load in src/lib/profile.mjs - the trade's half from
  // the engine, the supplier's half from the client profile - so a deployment's
  // words can grow by editing config/client.json and touching no source.
  const profile = loadProfile();
  for (const word of ['tender', 'e-tender', 'procurement', 'supply of', 'rfq', 'eoi', 'expression of interest', 'empanel', 'rate contract', 'annual supply', 'canteen contract', 'mess contract', 'vendor registration', 'supplier']) {
    assert.ok(profile.requirement.includes(word), `${word} is on the requirement list`);
  }
  assert.ok(profile.opening.includes('expansion'), 'the awareness list carries the expansion words');
});

test('a feed item carries its tier onto the candidate, and the source counts both', () => {
  const rss = `<rss><channel>
    <item><title>Tender floated for supply of vegetables to the hostel mess</title><link>https://paper.example/a</link></item>
    <item><title>New hotel opens in Whitefield</title><link>https://paper.example/b</link></item>
  </channel></rss>`;
  const { candidates, stats } = publishers.parseFeed(rss, { entry: { name: 'Paper', url: 'https://paper.example/feed' }, maxAgeDays: null });
  assert.deepEqual(candidates.map((c) => c.extra.matchTier), ['requirement_candidate', 'awareness']);
  assert.equal(stats.requirementCandidates, 1);
  assert.equal(stats.awareness, 1);
});

test('a lead with no tier on it is tiered from its own words', () => {
  const lead = (name) => ({ id: 'x', kind: 'signal', source: 'news', source_url: 'https://n/x', name, score: 10, extra: {} });
  assert.equal(openings.tierOf(lead('Canteen tender floated by the railway')), 'requirement_candidate');
  assert.equal(openings.tierOf(lead('New hotel opens in Bengaluru')), 'awareness');
  assert.equal(openings.tierOf(lead('Metro line opens between Majestic and Whitefield')), 'awareness');
  // A lane that has already read the summary is believed over the headline.
  assert.equal(
    openings.tierOf({ ...lead('Chalet Hotels targets 5,500 keys by FY30'), extra: { matchTier: 'requirement_candidate' } }),
    'requirement_candidate'
  );
});

// --------------------------------------------------------------------- cap

test('the lane reads no more articles in a run than OPENINGS_MAX_READS allows', async () => {
  const leads = [1, 2, 3, 4].map((n) => ({
    id: `c${n}`,
    kind: 'signal',
    source: 'publishers',
    source_url: `https://paper.example/tender-${n}`,
    name: `Tender floated for supply of vegetables to hostel mess ${n}`,
    city: 'Bengaluru',
    score: 100 - n,
    extra: { matchTier: 'requirement_candidate' },
  }));
  const page = '<html><body><p>The hostel mess tender invites quotations for the supply of vegetables.</p></body></html>';
  const fetched = [];
  const receipts = [];
  const out = await openings.upgradeSignals(leads, {
    runner: {
      notNeeded() {},
      ask: async () => ({ ok: true, value: { isRequirement: false, organisation: null, requirement: null, quantity: null, deadline: null, contactHint: null, site: null, evidence: [], confidence: 0.2 } }),
    },
    crawler: {
      robotsFor: async () => ({ allowed: true }),
      fetchDoc: async (url) => {
        fetched.push(url);
        return { ok: true, url, html: page, text: page.replace(/<[^>]+>/g, ' '), status: 200, kind: 'html' };
      },
    },
    chain: { add: (type, data) => receipts.push({ type, data }) },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs here'); },
    maxReads: 2,
  });

  assert.equal(out.readCap, 2);
  assert.equal(out.articlesRead, 2);
  assert.equal(fetched.length, 2, 'the cap counts fetches, not intentions');
  assert.equal(out.capReached, true);
  assert.equal(out.cappedOut, 2);

  const capped = receipts.filter((r) => r.type === 'openings.cap_reached');
  assert.equal(capped.length, 1, 'the cap is receipted once, not once per lead left unread');
  assert.equal(capped[0].data.cap, 2);
  assert.equal(capped[0].data.env, 'OPENINGS_MAX_READS');
  assert.match(leads[3].extra.contactNotFound, /article-read cap of 2/);
});

test('the cap comes from the environment, and a nonsense value is ignored', () => {
  assert.equal(openingsMaxReads({}), OPENINGS.maxReads);
  assert.equal(OPENINGS.maxReads, 6);
  assert.equal(openingsMaxReads({ OPENINGS_MAX_READS: '3' }), 3);
  assert.equal(openingsMaxReads({ OPENINGS_MAX_READS: '0' }), 0);
  assert.equal(openingsMaxReads({ OPENINGS_MAX_READS: 'plenty' }), OPENINGS.maxReads);
  assert.equal(openingsMaxReads({ OPENINGS_MAX_READS: '' }), OPENINGS.maxReads);
});

// ------------------------------------------------- the news lane, unchanged

test('the news lane still parses exactly as it did: the tiers are the openings lane\'s business', () => {
  const xml = `<rss><channel><item>
    <title>Canteen tender floated by the railway - The Hindu</title>
    <link>https://news.google.com/rss/articles/AU_yqLabc?oc=5</link>
    <pubDate>Wed, 10 Sep 2026 06:00:00 +0530</pubDate>
    <guid>g1</guid>
  </item><item>
    <title>New hotel opens in Whitefield - Deccan Herald</title>
    <link>https://news.google.com/rss/articles/AU_yqLdef?oc=5</link>
    <pubDate>Wed, 10 Sep 2026 06:00:00 +0530</pubDate>
    <guid>g2</guid>
  </item></channel></rss>`;
  const items = news.parseFeed(xml, { query: 'canteen tender', segment: 'institution', city: CITIES.bengaluru, feedUrl: 'https://news.google.com/rss/search?q=x' });

  assert.equal(items.length, 2, 'the news lane keeps what it always kept');
  assert.deepEqual(items.map((i) => i.name), ['Canteen tender floated by the railway', 'New hotel opens in Whitefield']);
  for (const item of items) {
    assert.equal(item.kind, 'signal');
    assert.equal(item.source, 'news');
    assert.equal(item.phone, null);
    assert.equal(item.extra.matchTier, undefined, 'the news source tiers nothing - it has only a headline');
    assert.equal(new URL(item.sourceUrl).hostname, 'news.google.com');
  }
  assert.equal(items[0].extra.publication, 'The Hindu');
  assert.equal(items[0].whyNow, 'reported 2026-09-10');

  // The tier is decided where the money is spent, from the same headline.
  const lead = (i, item) => ({ id: `n${i}`, kind: 'signal', source: 'news', source_url: item.sourceUrl, name: item.name, score: 40, extra: { ...item.extra } });
  assert.equal(openings.tierOf(lead(1, items[0])), 'requirement_candidate');
  assert.equal(openings.tierOf(lead(2, items[1])), 'awareness');
});
