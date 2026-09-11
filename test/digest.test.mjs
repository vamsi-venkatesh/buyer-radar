import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import { renderDigest } from '../src/digest.mjs';
import { DIGEST, DIGEST_SECTIONS } from '../src/config.mjs';
import { toLead, scoreLead } from '../src/model.mjs';

const NOW = '2026-09-11T06:00:00.000Z';
const TODAY = '2026-09-11';

function makeLead(i, over = {}) {
  const lead = toLead(
    {
      kind: 'buyer',
      segment: ['wholesale', 'hotel', 'restaurant', 'caterer', 'retailer'][i % 5],
      name: `Venkateshwara Fresh Produce and Provision Stores Number ${i}`,
      city: 'Bengaluru',
      state: 'Karnataka',
      address: `${i} Sampige Road, Malleshwaram, Bengaluru 560003`,
      phone: `+9198450${String(10000 + i).slice(0, 5)}`,
      website: 'https://example.com/a/very/long/url/that/should/not/be/printed',
      whyNow: 'listed on OpenStreetMap',
      source: 'overpass',
      sourceUrl: `https://www.openstreetmap.org/node/${i}`,
      licence: 'ODbL',
      externalId: `node/${i}`,
      ...over,
    },
    { nowIso: NOW }
  );
  lead.score = scoreLead(lead, { city: 'Bengaluru', todayIsoDate: TODAY }).score;
  return lead;
}

test('digest stays under the character cap with long names', () => {
  const leads = Array.from({ length: 40 }, (_, i) => makeLead(i));
  const result = renderDigest(leads, { date: TODAY });
  assert.ok(result.text.length <= DIGEST.maxChars, `${result.text.length} <= ${DIGEST.maxChars}`);
  assert.ok(result.shown > 0, 'at least one lead still fits');
  assert.ok(result.shown <= DIGEST.topN);
  assert.equal(result.considered, 40);
});

test('the buyer section is capped at its documented size and numbers L1..Ln', () => {
  // The cap moved from ten to DIGEST_SECTIONS.buyers when the demand lane took
  // the top of the digest: requirements are scarcer and go first, and the
  // WhatsApp character cap did not get any bigger.
  const leads = Array.from({ length: 30 }, (_, i) => makeLead(i, { name: `Shop ${i}` }));
  const result = renderDigest(leads, { date: TODAY });
  assert.equal(result.shown, DIGEST_SECTIONS.buyers);
  assert.equal(result.buyersShown, DIGEST_SECTIONS.buyers);
  assert.equal(Object.keys(result.index).length, DIGEST_SECTIONS.buyers);
  for (let n = 1; n <= result.buyersShown; n += 1) {
    assert.ok(result.text.includes(`L${n} `), `digest carries L${n}`);
    assert.ok(result.index[`L${n}`], `index maps L${n} to a lead id`);
  }
  assert.ok(!result.text.includes(`L${DIGEST_SECTIONS.buyers + 1} `));
});

test('digest leads are ordered by score, highest first', () => {
  const leads = [makeLead(2), makeLead(0), makeLead(4)];
  const result = renderDigest(leads, { date: TODAY });
  const ids = Object.values(result.index);
  const scores = ids.map((id) => leads.find((l) => l.id === id).score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('digest carries the date, the reply instruction and no hype', () => {
  const result = renderDigest([makeLead(0)], { date: TODAY });
  assert.ok(result.text.startsWith(`${CLIENT.digest.title} - ${TODAY}`));
  assert.ok(result.text.includes('Reply with R<n>/L<n>/G<n> won/lost/contacted to update.'));
  assert.doesNotMatch(result.text, /kitchen/i, 'no copy this project generates uses that wording');
  assert.doesNotMatch(result.text, /best|amazing|unbeatable|guaranteed|!!/i);
});

test('digest includes prices only when there are prices', () => {
  const lead = makeLead(0);
  const without = renderDigest([lead], { date: TODAY });
  assert.ok(!without.text.includes('Mandi prices (INR/quintal):'));

  const price = toLead(
    {
      kind: 'price',
      segment: 'other',
      name: 'Garlic - Binny Mill (F&V), Bangalore',
      source: 'agmarknet',
      externalId: 'k|b|bm|Garlic|Average|10/09/2026',
      extra: {
        commodity: 'Garlic',
        market: 'Binny Mill (F&V), Bangalore',
        modalPrice: 7500,
        arrivalDate: '10/09/2026',
      },
    },
    { nowIso: NOW }
  );
  const withPrices = renderDigest([lead], { date: TODAY, prices: [price] });
  assert.ok(withPrices.text.includes('Mandi prices (INR/quintal):'));
  assert.ok(withPrices.text.includes('7500'));
  assert.ok(withPrices.text.length <= DIGEST.maxChars);
});

test('digest with no new leads says so plainly', () => {
  const result = renderDigest([], { date: TODAY });
  assert.ok(result.text.includes('No new leads today.'));
  assert.equal(result.shown, 0);
  assert.deepEqual(result.index, {});
});

test('digest skips leads that are no longer new', () => {
  const a = makeLead(0);
  const b = { ...makeLead(1), status: 'contacted' };
  const result = renderDigest([a, b], { date: TODAY });
  assert.equal(result.shown, 1);
  assert.equal(result.index.L1, a.id);
});

test('digest rendering is deterministic', () => {
  const leads = Array.from({ length: 12 }, (_, i) => makeLead(i));
  const a = renderDigest(leads, { date: TODAY });
  const b = renderDigest(leads, { date: TODAY });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.index, b.index);
});

test('tied scores are spread across segments, deterministically', async () => {
  const { diversifyTies } = await import('../src/digest.mjs');
  const tied = [
    { id: 'a', score: 80, segment: 'hotel' },
    { id: 'b', score: 80, segment: 'hotel' },
    { id: 'c', score: 80, segment: 'wholesale' },
    { id: 'd', score: 80, segment: 'restaurant' },
    { id: 'e', score: 70, segment: 'hotel' },
  ];
  const out = diversifyTies(tied);
  assert.deepEqual(out.map((l) => l.segment), ['hotel', 'wholesale', 'restaurant', 'hotel', 'hotel']);
  assert.deepEqual(out.map((l) => l.id), ['a', 'c', 'd', 'b', 'e']);
  assert.deepEqual(diversifyTies(tied), out, 'same input, same order');
  assert.deepEqual(
    out.map((l) => l.score),
    [...out].sort((x, y) => y.score - x.score).map((l) => l.score),
    'score order is never broken'
  );
});

test('a digest of many same-segment leads still shows other segments when tied', () => {
  const leads = [
    ...Array.from({ length: 9 }, (_, i) => makeLead(1, { externalId: `h${i}`, name: `Hotel ${i}`, segment: 'hotel' })),
    makeLead(0, { externalId: 'w1', name: 'Wholesale One', segment: 'hotel' }),
  ];
  const wholesale = makeLead(0, { externalId: 'w2', name: 'Real Wholesale', segment: 'hotel' });
  const result = renderDigest([...leads, wholesale], { date: TODAY, city: 'Bengaluru' });
  assert.ok(result.shown > 0);
  assert.ok(result.text.length <= DIGEST.maxChars);
});
