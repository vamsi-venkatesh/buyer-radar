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
import { OPENINGS } from '../src/config.mjs';

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
  assert.deepEqual(chosen.map((l) => l.id), ['a', 'b']);
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
    [google('g1', 99), { ...make('p1', 'publishers', 'Hotel opens in Bengaluru'), score: 10 }, google('g2', 98)],
    { limit: 2, promptVersion: 'v1' }
  );
  assert.deepEqual(order.map((l) => l.id), ['p1', 'g1']);
});

test('REAL: a publisher signal is read from the publisher\'s page, with no request to Google', async () => {
  const html = await read('publishers-article-hospitality.html');
  const { candidates } = publishers.parseFeed(await read('publishers-feed-et-hospitalityworld.xml'), { entry: ET_HOSPITALITY, maxAgeDays: null });
  const candidate = candidates.find((c) => /Chalet Hotels/i.test(c.name));
  assert.ok(candidate, 'the fixture carries the item whose page was saved');
  const lead = leadFrom(candidate, 'l1');

  const fetched = [];
  const crawler = {
    robotsFor: async () => { throw new Error('the openings lane must not ask Google for robots.txt here'); },
    fetchDoc: async (url) => {
      fetched.push(url);
      if (url === candidate.sourceUrl) return { ok: true, url, html, text: htmlToText(html, { maxChars: 20000 }), status: 200, kind: 'html' };
      if (url === 'https://chalethotels.example') {
        const page = '<html><body><p>Chalet Hotels. Purchase Officer: Shri A Rao. Phone: 022-2726 5555</p></body></html>';
        return { ok: true, url, html: page, text: page.replace(/<[^>]+>/g, ' '), status: 200, kind: 'html' };
      }
      return { ok: false, reason: 'HTTP 404', url };
    },
  };
  let asked = 0;
  const runner = {
    notNeeded() { throw new Error('this article gives the deterministic readers nothing, so the model is needed'); },
    ask: async ({ input }) => {
      asked += 1;
      assert.match(input, /Article text:/);
      assert.match(input, /Chalet Hotels/);
      return {
        ok: true,
        value: {
          isRequirement: true,
          organisation: 'Chalet Hotels',
          requirement: 'fresh produce for the new keys',
          quantity: null,
          deadline: null,
          contactHint: null,
          site: 'https://chalethotels.example',
          evidence: ['targets 5,500 keys by FY30'],
          confidence: 0.9,
        },
      };
    },
  };
  const receipts = [];
  const out = await openings.upgradeSignals([lead], {
    runner,
    crawler,
    chain: { add: (type, data) => receipts.push({ type, data }) },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs in this lane for a direct publisher URL'); },
  });

  assert.equal(out.considered, 1);
  assert.equal(out.linksResolved, 0, 'a publisher URL needs no resolving - it is already the article');
  assert.equal(out.linksUnresolved, 0);
  assert.equal(out.articlesRead, 1);
  assert.equal(asked, 1);
  assert.equal(fetched[0], candidate.sourceUrl);
  assert.equal(lead.kind, 'requirement');
  assert.equal(lead.phone, '+912227265555');
  assert.equal(lead.extra.document_url, candidate.sourceUrl);
  assert.equal(lead.extra.organisation, 'Chalet Hotels');
  assert.ok(receipts.some((r) => r.type === 'openings.article_read' && r.data.publisher === 'hospitality.economictimes.indiatimes.com'));
  assert.ok(receipts.some((r) => r.type === 'openings.upgraded'));
});

test('REAL: a phone number on a newspaper page is the newspaper\'s, and is never the buyer\'s contact', async () => {
  const html = await read('publishers-article-telanganatoday.html');
  const { candidates } = publishers.parseFeed(await read('publishers-feed-telangana-today.xml'), { entry: TELANGANA, maxAgeDays: null });
  const candidate = candidates.find((c) => /Loyola Academy/i.test(c.name));
  assert.ok(candidate);
  const lead = leadFrom(candidate, 'l2');

  // The deterministic readers do get something off this page - a date - and the
  // old rule would have stopped there and used whatever contact the page
  // carried. The page belongs to Telangana Today.
  const text = htmlToText(html, { maxChars: 20000 });
  assert.ok(openings.deterministicReads(text, { todayIsoDate: '2026-09-11' }).deadline, 'a date is readable on the page');

  const fetched = [];
  const crawler = {
    robotsFor: async () => { throw new Error('no Google robots.txt read belongs here'); },
    fetchDoc: async (url) => {
      fetched.push(url);
      return { ok: true, url, html, text, status: 200, kind: 'html' };
    },
  };
  let asked = 0;
  const out = await openings.upgradeSignals([lead], {
    runner: {
      notNeeded: () => { throw new Error('a publisher article is never answerable without the model'); },
      ask: async () => {
        asked += 1;
        // The model read the article and offered the newspaper as the site.
        return {
          ok: true,
          value: {
            isRequirement: true,
            organisation: 'Loyola Academy',
            requirement: 'provisions for the college canteen',
            quantity: null,
            deadline: null,
            contactHint: null,
            site: 'https://telanganatoday.com',
            evidence: [],
            confidence: 0.9,
          },
        };
      },
    },
    crawler,
    chain: { add() {} },
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => { throw new Error('no network call belongs here'); },
  });

  assert.equal(out.articlesRead, 1);
  assert.equal(asked, 1);
  assert.equal(out.notNeeded, 0);
  assert.equal(out.upgraded, 0);
  assert.deepEqual(fetched, [candidate.sourceUrl], 'the newspaper is read once as an article and never as a buyer\'s site');
  assert.equal(lead.kind, 'signal');
  assert.ok(!lead.phone, 'no number was written onto the lead');
  assert.equal(lead.extra.contactComplete, false);
  assert.match(lead.extra.contactNotFound, /refused host telanganatoday\.com/);
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
    source_url: 'https://walled.example/city/new-hotel-opens',
    name: 'New hotel opens in Bengaluru',
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
  assert.match(skipped.data.reason, /robots\.txt disallows \/city\/new-hotel-opens/);
  assert.equal(crawler.stats().blockedByRobots, 1);
});
