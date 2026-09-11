import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toLead,
  upsertLeads,
  scoreLead,
  mergeLeads,
  phoneKey,
  nameCityKey,
  SEGMENT_POINTS,
} from '../src/model.mjs';
import { normalisePhone, normaliseName } from '../src/lib/normalise.mjs';

const NOW = '2026-09-11T06:00:00.000Z';
const TODAY = '2026-09-11';

function candidate(over = {}) {
  return {
    kind: 'buyer',
    segment: 'restaurant',
    name: 'Empire Restaurant',
    city: 'Bengaluru',
    state: 'Karnataka',
    address: '12 Church Street, Bengaluru',
    phone: '+91 80 4112 3456',
    email: null,
    website: null,
    whyNow: 'listed on OpenStreetMap',
    whyNowDate: null,
    source: 'overpass',
    sourceUrl: 'https://www.openstreetmap.org/node/1',
    licence: 'ODbL',
    externalId: 'node/1',
    extra: {},
    ...over,
  };
}

test('lead id is a stable function of source and external id', () => {
  const a = toLead(candidate(), { nowIso: NOW });
  const b = toLead(candidate({ name: 'Different Name' }), { nowIso: '2027-01-01T00:00:00.000Z' });
  assert.equal(a.id, b.id, 'same source + external id must produce the same id');
  const c = toLead(candidate({ externalId: 'node/2' }), { nowIso: NOW });
  assert.notEqual(a.id, c.id);
  assert.match(a.id, /^[0-9a-f]{16}$/);
});

test('dedup by normalised phone merges two different listings', () => {
  const a = toLead(candidate({ segment: 'retailer' }), { nowIso: NOW });
  const b = toLead(
    candidate({
      name: 'Empire Restaurant Church Street',
      externalId: 'node/99',
      source: 'news',
      phone: '080-41123456',
      segment: 'wholesale',
    }),
    { nowIso: NOW }
  );
  assert.equal(a.phone, b.phone, 'both phones normalise to the same E.164 value');

  const { leads, newCount, duplicateCount } = upsertLeads([a], [b]);
  assert.equal(leads.length, 1);
  assert.equal(newCount, 0);
  assert.equal(duplicateCount, 1);
  assert.equal(leads[0].id, a.id, 'the existing lead wins the id');
  assert.equal(leads[0].segment, 'wholesale', 'the higher-fit segment is kept');
  assert.deepEqual(leads[0].extra.sources, ['overpass', 'news']);
});

test('dedup by normalised name + city when there is no phone', () => {
  const a = toLead(candidate({ phone: null, name: 'Sri Lakshmi Vegetables Pvt Ltd' }), { nowIso: NOW });
  const b = toLead(
    candidate({ phone: null, name: 'SRI LAKSHMI VEGETABLES', externalId: 'node/77' }),
    { nowIso: NOW }
  );
  assert.equal(normaliseName(a.name), normaliseName(b.name));
  const { leads, duplicateCount } = upsertLeads([a], [b]);
  assert.equal(leads.length, 1);
  assert.equal(duplicateCount, 1);
});

test('different cities with the same name are not merged', () => {
  const a = toLead(candidate({ phone: null }), { nowIso: NOW });
  const b = toLead(candidate({ phone: null, city: 'Chennai', externalId: 'node/55' }), { nowIso: NOW });
  assert.notEqual(nameCityKey(a), nameCityKey(b));
  const { leads } = upsertLeads([a], [b]);
  assert.equal(leads.length, 2);
});

test('re-running the same candidates does not create new leads', () => {
  const first = upsertLeads([], [toLead(candidate(), { nowIso: NOW })]);
  const second = upsertLeads(first.leads, [toLead(candidate(), { nowIso: '2026-09-12T06:00:00.000Z' })]);
  assert.equal(second.leads.length, 1);
  assert.equal(second.newCount, 0);
  assert.equal(second.updatedCount, 1);
  assert.equal(second.leads[0].first_seen, NOW, 'first_seen is the earliest sighting');
  assert.equal(second.leads[0].last_seen, '2026-09-12T06:00:00.000Z');
});

test('phoneKey is null without a parseable phone', () => {
  const a = toLead(candidate({ phone: 'call us' }), { nowIso: NOW });
  assert.equal(a.phone, null);
  assert.equal(phoneKey(a), null);
});

test('scoring is deterministic and bounded', () => {
  const lead = toLead(candidate(), { nowIso: NOW });
  const a = scoreLead(lead, { city: 'Bengaluru', todayIsoDate: TODAY });
  const b = scoreLead(lead, { city: 'Bengaluru', todayIsoDate: TODAY });
  assert.deepEqual(a, b);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.parts.segment, SEGMENT_POINTS.restaurant);
  assert.equal(a.parts.contactability, 30, 'a phone is worth the full contactability band');
  assert.equal(a.parts.cityMatch, 10);
});

test('scoring order: phone beats email beats website beats nothing', () => {
  const base = { city: 'Bengaluru', todayIsoDate: TODAY };
  const withPhone = scoreLead(toLead(candidate(), { nowIso: NOW }), base).score;
  const withEmail = scoreLead(
    toLead(candidate({ phone: null, email: 'orders@example.com' }), { nowIso: NOW }),
    base
  ).score;
  const withSite = scoreLead(
    toLead(candidate({ phone: null, website: 'example.com' }), { nowIso: NOW }),
    base
  ).score;
  const withNone = scoreLead(toLead(candidate({ phone: null }), { nowIso: NOW }), base).score;
  assert.ok(withPhone > withEmail, `${withPhone} > ${withEmail}`);
  assert.ok(withEmail > withSite, `${withEmail} > ${withSite}`);
  assert.ok(withSite > withNone, `${withSite} > ${withNone}`);
});

test('a why_now within 14 days scores above an older one', () => {
  const base = { city: 'Bengaluru', todayIsoDate: TODAY };
  const fresh = toLead(candidate({ whyNowDate: '2026-09-08', whyNow: 'reported 2026-09-08' }), { nowIso: NOW });
  const stale = toLead(candidate({ whyNowDate: '2026-06-01', whyNow: 'reported 2026-06-01' }), { nowIso: NOW });
  assert.equal(scoreLead(fresh, base).parts.recency, 20);
  assert.equal(scoreLead(stale, base).parts.recency, 0);
});

test('a lead that is already contacted takes the duplicate penalty', () => {
  const base = { city: 'Bengaluru', todayIsoDate: TODAY };
  const lead = toLead(candidate(), { nowIso: NOW });
  const clean = scoreLead(lead, base).score;
  const contacted = scoreLead({ ...lead, status: 'contacted' }, base);
  assert.equal(contacted.parts.penalty, -25);
  assert.ok(contacted.score < clean);
});

test('merging never overwrites register-owned status and notes', () => {
  const existing = {
    ...toLead(candidate(), { nowIso: NOW }),
    status: 'quoted',
    notes: '2026-09-10 quoted: 40 kg peeled garlic',
  };
  const incoming = toLead(candidate({ externalId: 'node/1' }), { nowIso: '2026-09-12T00:00:00.000Z' });
  const merged = mergeLeads(existing, incoming);
  assert.equal(merged.status, 'quoted');
  assert.equal(merged.notes, existing.notes);
});

test('phone normalisation rejects what it cannot parse', () => {
  assert.equal(normalisePhone('+91 98450 12345'), '+919845012345');
  assert.equal(normalisePhone('09845012345'), '+919845012345');
  assert.equal(normalisePhone('9845012345'), '+919845012345');
  assert.equal(normalisePhone('+91 80 4112 3456'), '+918041123456');
  assert.equal(normalisePhone('98450 12345; 98450 12346'), '+919845012345');
  assert.equal(normalisePhone('12345'), null);
  assert.equal(normalisePhone(''), null);
  assert.equal(normalisePhone(null), null);
});

test('the four segments a produce supplier sells into directly share the top band', () => {
  const top = ['wholesale', 'hotel', 'restaurant', 'food_manufacturer'];
  for (const s of top) assert.equal(SEGMENT_POINTS[s], 30, `${s} is in the top band`);
  for (const [seg, pts] of Object.entries(SEGMENT_POINTS)) {
    if (!top.includes(seg)) assert.ok(pts < 30, `${seg} scores below the top band`);
  }
});
