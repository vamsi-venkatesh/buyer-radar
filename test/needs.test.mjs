// Model only when needed, and read the publisher rather than Google.
//
// Two separate things, tested together because they are the same decision made
// twice: do not spend anything - money or somebody else's bandwidth - until
// there is a reason to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { needsModel, concreteFacts, digestCutoffs, cutoffFor, ENRICH_CUTOFF_BAND } from '../src/llm/needs.mjs';
import {
  isGoogleNewsLink,
  googleNewsId,
  decodeArticleId,
  followRedirect,
  resolveNewsLink,
} from '../src/lib/news-link.mjs';
import { parseRobots } from '../src/llm/page.mjs';
import { toLead } from '../src/model.mjs';

const NOW = '2026-09-11T06:00:00.000Z';

function lead(over = {}) {
  const { llm, extra, ...rest } = over;
  const l = toLead(
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
    { nowIso: NOW }
  );
  l.extra = { ...l.extra, ...(extra || {}), ...(llm ? { llm } : {}) };
  if (over.score !== undefined) l.score = over.score;
  if (over.segment_source !== undefined) l.segment_source = over.segment_source;
  return l;
}

// ------------------------------------------------------------------- enrich

test('enrich: the truth table', () => {
  const base = { hasText: true, cacheHit: false, cutoff: 50 };

  // A cached answer is free, so the rules never get asked to justify it.
  assert.equal(needsModel('enrich', lead(), { ...base, cacheHit: true }).needed, false);
  assert.match(needsModel('enrich', lead(), { ...base, cacheHit: true }).reason, /the cache already holds an answer/);

  // Nothing to read is nothing to ask about.
  assert.equal(needsModel('enrich', lead({ segment: 'other' }), { ...base, hasText: false }).needed, false);
  assert.match(needsModel('enrich', lead({ segment: 'other' }), { ...base, hasText: false }).reason, /no page or article text/);

  // Rule one: the source gave no segment.
  const noSegment = needsModel('enrich', lead({ segment: 'other' }), base);
  assert.equal(noSegment.needed, true);
  assert.match(noSegment.reason, /no segment beyond "other"/);

  // Rule two: size unknown AND within the band of the digest cut-off.
  const atCutoff = needsModel('enrich', lead({ score: 50 }), { ...base, cutoff: 50 });
  assert.equal(atCutoff.needed, true);
  assert.match(atCutoff.reason, /the size is unknown and the score 50 is 0 from the digest cut-off 50/);
  assert.equal(needsModel('enrich', lead({ score: 50 - ENRICH_CUTOFF_BAND }), { ...base, cutoff: 50 }).needed, true);
  assert.equal(needsModel('enrich', lead({ score: 50 - ENRICH_CUTOFF_BAND - 1 }), { ...base, cutoff: 50 }).needed, false);
  assert.equal(needsModel('enrich', lead({ score: 50 + ENRICH_CUTOFF_BAND + 1 }), { ...base, cutoff: 50 }).needed, false);

  // A size already read is not read again, however near the cut-off it sits.
  assert.equal(needsModel('enrich', lead({ score: 50, llm: { size: 'large' } }), { ...base, cutoff: 50 }).needed, false);

  // Rule three: a requirement with no closing date.
  const undated = needsModel('enrich', lead({ kind: 'requirement', score: 99, extra: { deadline: null } }), { ...base, cutoff: 10 });
  assert.equal(undated.needed, true);
  assert.match(undated.reason, /carries no closing date/);
  assert.equal(
    needsModel('enrich', lead({ kind: 'requirement', score: 99, extra: { deadline: '2026-09-30' } }), { ...base, cutoff: 10 }).needed,
    false
  );

  // None of the three: nothing to buy.
  const nothing = needsModel('enrich', lead({ score: 99 }), { ...base, cutoff: 10 });
  assert.equal(nothing.needed, false);
  assert.match(nothing.reason, /the source already gave a segment/);
});

test('a cut-off of zero - a section showing everything it has - never triggers the size rule', () => {
  assert.equal(needsModel('enrich', lead({ score: 0 }), { hasText: true, cacheHit: false, cutoff: 0 }).needed, false);
});

// ------------------------------------------------------------------- opener

test('opener: only for a lead the digest shows, and only with a concrete fact', () => {
  const plain = lead();
  assert.deepEqual(concreteFacts(plain), []);
  assert.equal(needsModel('opener', plain, { inDigest: true }).needed, false);
  assert.match(needsModel('opener', plain, { inDigest: true }).reason, /no concrete fact/);

  const withEvidence = lead({ llm: { evidence: ['We buy 200 kg of vegetables a day.'] } });
  assert.equal(needsModel('opener', withEvidence, { inDigest: true }).needed, true);
  assert.equal(needsModel('opener', withEvidence, { inDigest: false }).needed, false);
  assert.match(needsModel('opener', withEvidence, { inDigest: false }).reason, /not showing this lead today/);

  assert.deepEqual(concreteFacts(lead({ llm: { pageTitle: 'Empire Kitchen, Bengaluru' } })), ['the title of their website']);
  assert.deepEqual(concreteFacts(lead({ extra: { requirement: 'Supply of fresh vegetables' } })), ['the requirement text on the notice']);
  assert.deepEqual(concreteFacts(lead({ extra: { quantity: '1,500 kg' } })), ['a stated quantity']);
});

// -------------------------------------------------------------- requirement

test('requirement: the model is asked only when the deterministic readers found nothing', () => {
  const none = needsModel('requirement', lead(), { hasText: true, deterministic: {} });
  assert.equal(none.needed, true);
  assert.match(none.reason, /found no quantity, no closing date and no contact/);

  for (const [field, label] of [['quantity', 'a quantity'], ['deadline', 'a closing date'], ['contact', 'a contact']]) {
    const d = needsModel('requirement', lead(), { hasText: true, deterministic: { [field]: field === 'contact' ? true : 'x' } });
    assert.equal(d.needed, false, field);
    assert.match(d.reason, new RegExp(`already found ${label}`));
  }

  assert.equal(needsModel('requirement', lead(), { hasText: false, deterministic: {} }).needed, false);
});

test('requirement: a publisher article always needs the model, whatever a regex read off it', () => {
  // The notice case: the body published it, so what is on it is that body's own.
  const notice = needsModel('requirement', lead(), { hasText: true, deterministic: { quantity: '500 kg', deadline: '2026-09-30', contact: true } });
  assert.equal(notice.needed, false);

  // The same three facts, read off a newspaper's page about somebody else.
  const article = needsModel('requirement', lead(), {
    hasText: true,
    needsOrganisation: true,
    deterministic: { quantity: '500 kg', deadline: '2026-09-30', contact: true },
  });
  assert.equal(article.needed, true);
  assert.match(article.reason, /names no buyer|names the buyer/);

  // Still nothing to read is still nothing to pay for.
  assert.equal(needsModel('requirement', lead(), { hasText: false, needsOrganisation: true }).needed, false);
});

test('requirement: no procurement wording in the text, no model call at any price', () => {
  // The pre-check sits above every other requirement rule, the article rule
  // included. An expansion story cannot state a posted requirement, and the
  // first real run of the openings lane paid for 34 calls on 12 expansion
  // stories to be told that 12 times.
  const awareness =
    'Chalet Hotels targets 5,500 keys by FY30 and will open new properties in Bengaluru and Hyderabad, the company said.';
  const refused = needsModel('requirement', lead(), { hasText: true, text: awareness, needsOrganisation: true, deterministic: {} });
  assert.equal(refused.needed, false);
  assert.equal(refused.reason, 'no procurement wording');

  // One word from the configured requirement list is enough to let the rules
  // below decide on their own.
  for (const text of [
    'The university has invited quotations for the annual supply of vegetables to its hostel mess.',
    'An e-tender was floated for the canteen contract.',
    'EOI invited for vendor registration at the district hospital.',
  ]) {
    const allowed = needsModel('requirement', lead(), { hasText: true, text, needsOrganisation: true, deterministic: {} });
    assert.equal(allowed.needed, true, text);
  }

  // The pre-check only applies to text it was given. A caller that passes none
  // is answered by the rules that were there before it.
  assert.equal(needsModel('requirement', lead(), { hasText: true, needsOrganisation: true, deterministic: {} }).needed, true);
  assert.equal(needsModel('requirement', lead(), { hasText: false, text: awareness, deterministic: {} }).needed, false);
});

test('an unknown purpose is refused rather than defaulted to yes', () => {
  const res = needsModel('summarise', lead(), { hasText: true });
  assert.equal(res.needed, false);
  assert.match(res.reason, /unknown purpose/);
});

// ------------------------------------------------------------------ cut-offs

test('the cut-off is the score of the last lead each section has room for', () => {
  const buyers = [90, 80, 70, 60, 50, 40, 30].map((score, i) => lead({ externalId: `node/${i}`, score }));
  const cutoffs = digestCutoffs(buyers, { sections: { requirements: 6, buyers: 6 } });
  assert.equal(cutoffs.buyer, 40, 'six fit, so the sixth score is the boundary');
  assert.equal(cutoffs.requirement, 0, 'a section with nothing in it has no boundary');
  assert.equal(cutoffFor(buyers[0], cutoffs), 40);
  assert.equal(cutoffFor(lead({ kind: 'requirement' }), cutoffs), 0);

  const few = digestCutoffs(buyers.slice(0, 3), { sections: { requirements: 6, buyers: 6 } });
  assert.equal(few.buyer, 0, 'everything fits, so nothing is on the boundary');
});

// --------------------------------------------------------- the news resolver

/** The old-style article id: a small protobuf with the publisher URL in it. */
function legacyId(url) {
  const bytes = Buffer.from(url, 'latin1');
  return Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, bytes.length]),
    bytes,
    Buffer.from([0xd2, 0x01, 0x03, 0x41, 0x42, 0x43]),
  ]).toString('base64url');
}

// A real id from the 2026-09-11 feed, trimmed: the post-2024 opaque form, which
// carries no URL at all. Kept verbatim so a change in the format is visible.
const OPAQUE_ID =
  'CBMiwwFBVV95cUxNZ0RhSEx0QVRvS1JLMmtLYVpnam5GT1Bxd0RDQ2draVAtLWhPRTU2QnY5RV9PTjFqNzd3YUZoMGdl';

test('a Google News link is recognised and its id is taken off the path', () => {
  assert.equal(isGoogleNewsLink('https://news.google.com/rss/articles/ABC?oc=5'), true);
  assert.equal(isGoogleNewsLink('https://www.thehindu.com/news/x'), false);
  assert.equal(isGoogleNewsLink('not a url'), false);
  assert.equal(googleNewsId('https://news.google.com/rss/articles/ABC?oc=5'), 'ABC');
  assert.equal(googleNewsId('https://news.google.com/articles/XYZ'), 'XYZ');
  assert.equal(googleNewsId('https://news.google.com/rss/search?q=x'), null);
});

test('an id that carries the publisher URL decodes to it; one that does not returns null', () => {
  const url = 'https://www.thehindu.com/news/cities/bangalore/canteen-tender/article1234.ece';
  assert.equal(decodeArticleId(legacyId(url)), url);
  assert.equal(decodeArticleId(OPAQUE_ID), null, 'the post-2024 id carries no URL and is never guessed at');
  assert.equal(decodeArticleId(''), null);
  assert.equal(decodeArticleId(Buffer.from('no url in here at all').toString('base64url')), null);
  // A decoded URL that points back at Google is not a publisher.
  assert.equal(decodeArticleId(legacyId('https://news.google.com/rss/articles/again')), null);
});

test('resolveNewsLink takes the decoded id and makes no request at all', async () => {
  const url = 'https://www.deccanherald.com/india/karnataka/mess-tender-9876';
  let calls = 0;
  const res = await resolveNewsLink(`https://news.google.com/rss/articles/${legacyId(url)}?oc=5`, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should never be called');
    },
  });
  assert.deepEqual({ ok: res.ok, url: res.url, via: res.via }, { ok: true, url, via: 'id' });
  assert.equal(calls, 0);
});

test('a link that was never on Google is passed straight through', async () => {
  const res = await resolveNewsLink('https://www.thehindu.com/news/x', { fetchImpl: async () => { throw new Error('no'); } });
  assert.deepEqual({ ok: res.ok, via: res.via, host: res.host }, { ok: true, via: 'direct', host: 'www.thehindu.com' });
});

test('robots.txt decides whether the redirect walk happens at all', async () => {
  let fetched = 0;
  const res = await resolveNewsLink(`https://news.google.com/rss/articles/${OPAQUE_ID}?oc=5`, {
    fetchImpl: async () => {
      fetched += 1;
      return new Response('', { status: 302, headers: { location: 'https://publisher.example/story' } });
    },
    robotsFor: async () => parseRobots('User-agent: *\nDisallow: /\nAllow: /topics/\n', 'buyerradar'),
  });
  assert.equal(res.ok, false);
  assert.equal(fetched, 0, 'a disallowed path is never requested, not even for its headers');
  assert.match(res.reason, /robots\.txt disallows/);
});

test('when robots.txt allows it, the walk follows Location and never reads a body', async () => {
  const seen = [];
  let bodyReads = 0;
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), redirect: opts.redirect, method: opts.method });
    const body = {
      cancel: async () => {},
    };
    if (String(url).endsWith('/hop2')) {
      return { status: 302, body, headers: { get: () => 'https://www.weeklytimesnow.com.au/story/1' } };
    }
    if (String(url).includes('news.google.com')) {
      return { status: 302, body, headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://news.google.com/hop2' : null) } };
    }
    bodyReads += 1;
    return { status: 200, body, headers: { get: () => null } };
  };
  const res = await resolveNewsLink(`https://news.google.com/rss/articles/${OPAQUE_ID}?oc=5`, {
    fetchImpl,
    robotsFor: async () => parseRobots('User-agent: *\nAllow: /\n', 'buyerradar'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://www.weeklytimesnow.com.au/story/1');
  assert.equal(res.via, 'redirect');
  assert.equal(res.hops, 2);
  assert.equal(bodyReads, 0, 'the walk stops the moment the chain leaves Google');
  assert.equal(seen.every((s) => s.redirect === 'manual'), true);
});

test('a 200 with no Location is a failure with the reason, not a resolved link', async () => {
  const res = await followRedirect('https://news.google.com/rss/articles/X', {
    fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} }, headers: { get: () => null } }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /HTTP 200 with no Location header after 0 redirects/);
});

test('a chain that never leaves Google gives up rather than looping', async () => {
  const res = await followRedirect('https://news.google.com/a', {
    hops: 3,
    fetchImpl: async () => ({ status: 302, body: { cancel: async () => {} }, headers: { get: () => 'https://news.google.com/again' } }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /still on news\.google\.com after 3 redirects/);
});

// ------------------------------------------------- the lane, end to end

test('the openings lane resolves to the publisher, and records the reason when it cannot', async () => {
  const { upgradeSignals, deterministicReads } = await import('../src/sources/openings.mjs');
  const { ReceiptChain } = await import('../src/lib/receipts.mjs');

  const signals = [
    lead({
      kind: 'signal',
      segment: 'institution',
      source: 'news',
      website: null,
      name: 'IISc floats hostel mess vegetable supply tender',
      externalId: 'news/1',
      sourceUrl: `https://news.google.com/rss/articles/${legacyId('https://www.deccanherald.com/iisc-mess-tender')}?oc=5`,
    }),
    lead({
      kind: 'signal',
      segment: 'institution',
      source: 'news',
      website: null,
      name: 'New canteen contract opens at the medical college',
      externalId: 'news/2',
      sourceUrl: `https://news.google.com/rss/articles/${OPAQUE_ID}?oc=5`,
    }),
  ];

  const fetched = [];
  const crawler = {
    robotsFor: async () => parseRobots('User-agent: *\nDisallow: /\n', 'buyerradar'),
    async fetchDoc(url) {
      fetched.push(url);
      // The newspaper's page says what is wanted and gives the reporter's desk
      // number; the institute's own page is where a purchase contact lives.
      const article =
        'The institute has invited bids for the supply of 1,500 kg of vegetables a month to its hostel mess. ' +
        'Last date for submission: 30.09.2026. Reported by our correspondent.';
      const site = 'Indian Institute of Science. Stores and Purchase. Contact Person: Dr Anita Rao. Phone: 080-2293 2222.';
      return { ok: true, kind: 'html', url, html: '<p>x</p>', text: url.includes('iisc.example') ? site : article };
    },
  };
  const chain = new ReceiptChain('run_openings');
  const asked = [];
  const runner = {
    ask: async (req) => {
      asked.push(req.purpose);
      return {
        ok: true,
        value: {
          isRequirement: true,
          organisation: 'Indian Institute of Science',
          requirement: 'supply of 1,500 kg of vegetables a month to the hostel mess',
          quantity: '1,500 kg a month',
          deadline: '2026-09-30',
          contactHint: 'Dr Anita Rao',
          site: 'https://iisc.example',
          evidence: ['invited bids for the supply of 1,500 kg of vegetables a month'],
          confidence: 0.9,
        },
      };
    },
    notNeeded: ({ purpose, leadId, reason }) => chain.add('llm.not_needed', { purpose, leadId, reason }),
  };

  const out = await upgradeSignals(signals, {
    runner,
    crawler,
    chain,
    settings: { minConfidence: 0.7 },
    todayIsoDate: '2026-09-11',
    fetchImpl: async () => {
      throw new Error('the resolver must not reach the network in this test');
    },
  });

  assert.equal(out.linksResolved, 1, 'the decodable id resolved to the publisher');
  assert.equal(out.linksUnresolved, 1, 'the opaque id did not, and Google refuses the redirect walk');
  assert.deepEqual(
    fetched,
    ['https://www.deccanherald.com/iisc-mess-tender', 'https://iisc.example'],
    'the publisher for the article, then the buyer own site for the contact - and nothing else'
  );
  assert.equal(out.articlesRead, 1);
  assert.equal(asked.length, 1, 'a publisher article always needs the model: it names the buyer, the regexes cannot');
  assert.equal(out.notNeeded, 0);
  assert.equal(out.upgraded, 1);

  const upgraded = signals[0];
  assert.equal(upgraded.kind, 'requirement');
  assert.equal(upgraded.phone, '+918022932222', 'the number came off the institute own site, not off the newspaper');
  assert.equal(upgraded.extra.contactFoundOn, 'https://iisc.example');
  assert.equal(upgraded.extra.deadline, '2026-09-30');
  assert.equal(upgraded.extra.quantity, '1,500 kg');

  const skipped = chain.receipts.find((r) => r.type === 'openings.link_unresolved');
  assert.equal(skipped.leadId, signals[1].id);
  assert.match(skipped.reason, /carries no publisher URL/);
  assert.match(signals[1].extra.contactNotFound, /could not be resolved to the publisher/);

  assert.equal(
    chain.receipts.find((r) => r.type === 'llm.not_needed'),
    undefined,
    'nothing about a publisher article is answerable without the model'
  );

  // The helper itself, on the same text.
  const read = deterministicReads(crawler.fetchDoc ? 'Last date for submission: 30.09.2026' : '', { todayIsoDate: '2026-09-11' });
  assert.equal(read.deadline, '2026-09-30');
});
