// One morning, one message.
//
// The cron runs several cities one after another. Meta applies a per-recipient
// frequency cap to a MARKETING template, so five separate messages is not five
// deliveries - it is however many the cap lets through. These tests cover the
// combination itself: what goes first, what is printed once, what happens to
// the character cap, and what the message says about a city that did not run.
//
// Nothing here touches the network. Every send is a stub and every number is a
// placeholder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  combineDigests,
  combineFromLeads,
  dedupePrices,
  renderDigest,
  renderPriceSheet,
  writeCombinedDigest,
  writeDigest,
} from '../src/digest.mjs';
import { latestDigest } from '../src/lib/digest-files.mjs';
import { templateParams, TEMPLATE_PARAM_LIMITS, deliverWhatsApp, metaError } from '../src/deliver.mjs';
import { cronConfig, deliverCombined, runOnce, DELIVER_MODES } from '../src/cron.mjs';
import { CLIENT } from '../src/client.mjs';
import { DIGEST } from '../src/config.mjs';
import { toLead, scoreLead } from '../src/model.mjs';

const NOW = '2026-09-14T01:30:00.000Z';
const TODAY = '2026-09-14'; // registrations are asked for explicitly, never assumed from the weekday
const TITLE = CLIENT.digest.title;
const TEMPLATE = 'buyer_radar_digest';
const tmp = () => mkdtemp(path.join(tmpdir(), 'radar-combined-'));

const CITY_STATE = {
  Bengaluru: 'Karnataka',
  Chennai: 'Tamil Nadu',
  Mumbai: 'Maharashtra',
  Delhi: 'Delhi',
  Hyderabad: 'Telangana',
};

function buyer(city, i, over = {}) {
  const lead = toLead(
    {
      kind: 'buyer',
      segment: ['hotel', 'restaurant', 'wholesale', 'caterer', 'retailer'][i % 5],
      name: `${city} Fresh Produce ${i}`,
      city,
      state: CITY_STATE[city],
      phone: `+9112345${String(10000 + i).slice(0, 5)}`,
      whyNow: 'listed on OpenStreetMap',
      source: 'overpass',
      sourceUrl: `https://www.openstreetmap.org/node/${city}${i}`,
      licence: 'ODbL',
      externalId: `node/${city}/${i}`,
      ...over,
    },
    { nowIso: NOW }
  );
  lead.score = scoreLead(lead, { city, todayIsoDate: TODAY }).score;
  return lead;
}

function requirement(city, i, over = {}) {
  const lead = toLead(
    {
      kind: 'requirement',
      segment: 'institution',
      name: `${city} Institute of Technology ${i}`,
      city,
      state: CITY_STATE[city],
      whyNow: 'tender posted',
      source: 'institutions',
      sourceUrl: `https://example.test/${city}/${i}`,
      externalId: `tender/${city}/${i}`,
      extra: {
        requirement: 'vegetables for the hostel mess',
        quantity: `${100 * (i + 1)} kg per week`,
        deadline: '2026-09-30',
        contact_phone: `+9112399${String(10000 + i).slice(0, 5)}`,
        document_url: `https://example.test/${city}/${i}.pdf`,
      },
      ...over,
    },
    { nowIso: NOW }
  );
  lead.score = scoreLead(lead, { city, todayIsoDate: TODAY }).score;
  return lead;
}

function price(state, commodity, modalPrice, market, arrivalDate = '13/09/2026') {
  return toLead(
    {
      kind: 'price',
      segment: 'other',
      name: `${commodity} - ${market}`,
      state,
      source: 'agmarknet',
      externalId: `${state}|${market}|${commodity}|${arrivalDate}`,
      extra: { commodity, market, modalPrice, arrivalDate },
    },
    { nowIso: NOW }
  );
}

/** What one city's run hands the combiner: its ranked sets, its prices, its uncapped sheet. */
function cityEntry(city, { buyers = [], requirements = [], prices = [] } = {}) {
  const leads = [...requirements, ...buyers];
  const digest = renderDigest(leads, { date: TODAY, city, prices });
  return {
    city,
    cityKey: city.toLowerCase(),
    sets: digest.sets,
    prices,
    full: digest.full,
    priceSheet: renderPriceSheet(prices, { date: TODAY, state: CITY_STATE[city] }),
    stats: {
      leads: buyers.length,
      withPhone: buyers.filter((l) => l.phone).length,
      requirements: requirements.length,
      requirementsWithContact: requirements.length,
    },
  };
}

// ------------------------------------------------------------------ ordering

test('the combined digest puts every city\'s requirements first, then buyers under a city heading, then prices once', () => {
  const entries = [
    cityEntry('Bengaluru', {
      requirements: [requirement('Bengaluru', 0)],
      buyers: [buyer('Bengaluru', 1), buyer('Bengaluru', 2)],
      prices: [price('Karnataka', 'Garlic', 7500, 'Binny Mill')],
    }),
    cityEntry('Chennai', {
      requirements: [requirement('Chennai', 0)],
      buyers: [buyer('Chennai', 3), buyer('Chennai', 4)],
      prices: [price('Tamil Nadu', 'Tomato', 1800, 'Koyambedu')],
    }),
  ];
  const combined = combineDigests(entries, { date: TODAY });

  assert.deepEqual(combined.cities, ['Bengaluru', 'Chennai']);
  assert.ok(combined.text.startsWith(`${TITLE} - ${TODAY} - Bengaluru, Chennai`));

  const at = (needle) => combined.text.indexOf(needle);
  assert.ok(at('REQUIREMENTS POSTED') > -1, 'requirements section is present');
  assert.ok(at('BUYERS TO APPROACH') > -1, 'buyer section is present');
  assert.ok(
    at('REQUIREMENTS POSTED') < at('BUYERS TO APPROACH'),
    'requirements come before buyers'
  );
  assert.ok(
    at('BUYERS TO APPROACH') < at('Mandi prices (INR/quintal):'),
    'prices come last'
  );

  // Both cities' requirements are in the one series, and both cities name
  // themselves over their own buyers.
  assert.match(combined.text, /R1 /);
  assert.match(combined.text, /R2 /);
  assert.ok(at('\nBengaluru\n') > at('BUYERS TO APPROACH'), 'the Bengaluru buyer block is named');
  assert.ok(at('\nChennai\n') > at('\nBengaluru\n'), 'Chennai follows, in the order the cities ran');

  // The buyer numbering is one series across the cities, so an L<n> reply is
  // unambiguous.
  const labels = [...combined.text.matchAll(/^L(\d+) /gm)].map((m) => Number(m[1]));
  assert.deepEqual(labels, labels.map((_, i) => i + 1));
  assert.equal(Object.keys(combined.index).filter((k) => k.startsWith('L')).length, labels.length);
});

test('the mandi price block is printed once, and the same quote from two city runs is printed once', () => {
  // Two cities in one state read the same mandi table; the run that merges the
  // register hands both of them the same price rows.
  const shared = [price('Karnataka', 'Garlic', 7500, 'Binny Mill'), price('Karnataka', 'Tomato', 1400, 'Binny Mill')];
  const entries = [
    cityEntry('Bengaluru', { buyers: [buyer('Bengaluru', 1)], prices: shared }),
    cityEntry('Chennai', { buyers: [buyer('Chennai', 2)], prices: [...shared, price('Tamil Nadu', 'Onion', 2200, 'Koyambedu')] }),
  ];
  const combined = combineDigests(entries, { date: TODAY });

  assert.equal(combined.text.split('Mandi prices (INR/quintal):').length - 1, 1, 'one price block');
  assert.equal(combined.text.split('Garlic Binny Mill').length - 1, 1, 'the shared garlic quote appears once');
  assert.equal(combined.prices.length, 3, 'three distinct quotes survive the dedupe');
  assert.match(combined.priceSheet, /Rs 7500\/qtl/);
});

test('dedupePrices keys on commodity, market, arrival date and price, and keeps the first sighting', () => {
  const a = price('Karnataka', 'Garlic', 7500, 'Binny Mill');
  const b = price('Karnataka', 'Garlic', 7500, 'Binny Mill');
  const c = price('Karnataka', 'Garlic', 7500, 'Binny Mill', '12/09/2026');
  const d = price('Karnataka', 'Garlic', 7400, 'Binny Mill');
  const out = dedupePrices([a, b, c, d]);
  assert.equal(out.length, 3);
  assert.equal(out[0], a);
  assert.deepEqual(dedupePrices([]), []);
});

test('a lead seen by two city runs is carried into the combined digest once', () => {
  // A city run merges the whole register, so the Chennai run's ranked sets also
  // hold the Bengaluru requirement the earlier run wrote.
  const shared = requirement('Bengaluru', 0);
  const entries = [
    cityEntry('Bengaluru', { requirements: [shared], buyers: [buyer('Bengaluru', 1)] }),
    cityEntry('Chennai', { requirements: [shared, requirement('Chennai', 0)], buyers: [buyer('Chennai', 2)] }),
  ];
  const combined = combineDigests(entries, { date: TODAY });
  assert.equal(combined.requirementsConsidered, 2, 'the shared requirement is counted once');
  assert.equal(new Set(Object.values(combined.index)).size, Object.keys(combined.index).length, 'no lead id is labelled twice');
});

test('a buyer is only ever printed under its own city', () => {
  // The same merged-register effect, for buyers: Chennai's run has Bengaluru's
  // buyers in its sets, and they must not be printed under the Chennai heading.
  const bengaluru = [buyer('Bengaluru', 1), buyer('Bengaluru', 2)];
  const entries = [
    cityEntry('Bengaluru', { buyers: bengaluru }),
    cityEntry('Chennai', { buyers: [...bengaluru, buyer('Chennai', 3)] }),
  ];
  const combined = combineDigests(entries, { date: TODAY, sections: { requirements: 6, buyersPerCity: 6, registrations: 0 } });
  const chennaiBlock = combined.text.slice(combined.text.indexOf('\nChennai\n'));
  assert.ok(!/Bengaluru Fresh Produce/.test(chennaiBlock), chennaiBlock);
});

// ------------------------------------------------------------------- the cap

test('the combined digest keeps the character cap, and sheds buyers before requirements', () => {
  const entries = ['Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Hyderabad'].map((city) =>
    cityEntry(city, {
      requirements: Array.from({ length: 3 }, (_, i) => requirement(city, i)),
      buyers: Array.from({ length: 8 }, (_, i) => buyer(city, i)),
      prices: [price(CITY_STATE[city], 'Garlic', 7500 + entriesIndex(city), `${city} APMC`)],
    })
  );
  const combined = combineDigests(entries, { date: TODAY });
  assert.ok(
    combined.text.length <= DIGEST.maxChars,
    `${combined.text.length} chars <= ${DIGEST.maxChars}`
  );
  assert.ok(combined.requirementsShown > 0, 'a requirement survives the cap');
  assert.ok(combined.shown > 0);
  // The email carries the uncapped per-city sheets, so it is much longer.
  assert.ok(combined.full.length > combined.text.length);
  for (const city of ['Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Hyderabad']) {
    assert.ok(combined.full.includes(`===== ${city} =====`), `the email inlines the ${city} sheet`);
  }
});

function entriesIndex(city) {
  return ['Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Hyderabad'].indexOf(city);
}

test('the combined digest is deterministic', () => {
  const build = () => [
    cityEntry('Bengaluru', { requirements: [requirement('Bengaluru', 0)], buyers: [buyer('Bengaluru', 1), buyer('Bengaluru', 2)] }),
    cityEntry('Chennai', { buyers: [buyer('Chennai', 3)] }),
  ];
  const a = combineDigests(build(), { date: TODAY });
  const b = combineDigests(build(), { date: TODAY });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.index, b.index);
});

// ------------------------------------------------------------ failed cities

test('a city that failed is named in the combined digest, above the cap\'s reach', () => {
  const entries = [cityEntry('Bengaluru', { buyers: [buyer('Bengaluru', 1)] })];
  const combined = combineDigests(entries, {
    date: TODAY,
    failed: [{ city: 'Mumbai', error: 'Error: overpass timed out' }, { city: 'Delhi', error: 'Error: no route to host' }],
  });
  assert.deepEqual(combined.failedCities, ['Mumbai', 'Delhi']);
  assert.match(combined.text, /^Not run today: Mumbai, Delhi\.$/m);
  assert.match(combined.full, /^Not run today: Mumbai, Delhi\.$/m);
  assert.ok(!combined.cities.includes('Mumbai'));
});

test('a morning where every city failed still says so instead of reading as a quiet day', () => {
  const combined = combineDigests([], { date: TODAY, failed: ['Bengaluru', 'Chennai'] });
  assert.match(combined.text, /Not run today: Bengaluru, Chennai\./);
  assert.match(combined.text, /No new leads today\./);
  assert.deepEqual(combined.cities, []);
});

// -------------------------------------------------------- template parameters

test('the template parameters carry the combined values and stay inside the approved lengths', () => {
  const entries = ['Bengaluru', 'Chennai', 'Mumbai'].map((city) =>
    cityEntry(city, {
      buyers: Array.from({ length: 6 }, (_, i) => buyer(city, i)),
      prices: [price(CITY_STATE[city], 'Garlic', 7500, `${city} APMC`)],
    })
  );
  const combined = combineDigests(entries, { date: TODAY });
  const params = templateParams({
    date: TODAY,
    digestText: combined.text,
    priceSheet: combined.priceSheet,
    stats: { leads: 154, withPhone: 119 },
  });

  assert.equal(params.length, 5);
  params.forEach((p, i) => {
    assert.ok(!/[\n\t]/.test(p), `parameter ${i + 1} has no newline`);
    assert.ok(p.length <= TEMPLATE_PARAM_LIMITS[i], `parameter ${i + 1}: ${p.length} <= ${TEMPLATE_PARAM_LIMITS[i]}`);
  });
  // Same meaning as before: the day, the lead count, the phone count, the top
  // three named buyers with their numbers, and a short price line.
  assert.equal(params[0], 'Monday, 14 September');
  assert.equal(params[1], '154');
  assert.equal(params[2], '119');
  assert.match(params[3], /Fresh Produce/);
  assert.match(params[4], /per quintal$/);
});

test('a very long combined digest still cuts each template parameter to its limit', () => {
  const huge = Array.from({ length: 40 }, (_, i) => `L${i + 1} ${'Very Long Buyer Name '.repeat(3)}${i} - hotel\n   +911234500${String(100 + i)} - listed`).join('\n');
  const params = templateParams({ date: TODAY, digestText: huge, priceSheet: '' });
  params.forEach((p, i) => assert.ok(p.length <= TEMPLATE_PARAM_LIMITS[i], `parameter ${i + 1}`));
});

// ------------------------------------------------------ the delivery attempt

test('the text is attempted first and the template is not sent when the text arrives', async () => {
  const outboxDir = await tmp();
  const calls = [];
  const result = await deliverWhatsApp({
    date: TODAY,
    digestText: 'combined digest',
    cities: ['Bengaluru', 'Chennai'],
    env: { WA_PHONE_NUMBER_ID: '15550001111', WA_TOKEN: 'tok', RADAR_TO_WA: '911234500000', WA_TEMPLATE: TEMPLATE },
    outboxDir,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body).type);
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.TEXT' }] }) };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(result.via, 'text');
  assert.deepEqual(calls, ['text'], 'exactly one request, and it is the text');
  assert.equal(result.template, null);
  assert.deepEqual(result.cities, ['Bengaluru', 'Chennai']);
  assert.deepEqual(await readdir(outboxDir), []);
});

test('a text refused outside the 24-hour window falls back to the template, and the refusal keeps its code', async () => {
  const outboxDir = await tmp();
  const calls = [];
  const result = await deliverWhatsApp({
    date: TODAY,
    digestText: 'combined digest',
    cities: ['Bengaluru'],
    env: { WA_PHONE_NUMBER_ID: '1', WA_TOKEN: 't', RADAR_TO_WA: '911234500000', WA_TEMPLATE: TEMPLATE },
    outboxDir,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.type);
      if (body.type === 'text') {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { code: 131047, message: 'Message failed to send because more than 24 hours have passed' } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.TPL' }] }) };
    },
  });
  assert.deepEqual(calls, ['text', 'template']);
  assert.equal(result.sent, true);
  assert.equal(result.via, 'template');
  assert.equal(result.messageId, 'wamid.TPL');
  assert.match(result.textRefused, /Meta error 131047/);
});

test('a template refused by the marketing frequency cap is recorded with Meta\'s code, never silently', async () => {
  const outboxDir = await tmp();
  const result = await deliverWhatsApp({
    date: TODAY,
    digestText: 'combined digest',
    cities: ['Bengaluru', 'Chennai'],
    env: { WA_PHONE_NUMBER_ID: '1', WA_TOKEN: 't', RADAR_TO_WA: '911234500000', WA_TEMPLATE: TEMPLATE },
    outboxDir,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: { code: 131049, message: 'This message was not delivered to maintain healthy ecosystem engagement.' },
      }),
    }),
  });
  assert.equal(result.sent, false);
  assert.match(result.reason, /Meta error 131049/);
  assert.match(result.reason, new RegExp(`template ${TEMPLATE} also refused`));
  assert.equal(result.error.code, 131049);
  assert.deepEqual(await readdir(outboxDir), [`${TODAY}.whatsapp.json`], 'the message is kept, not dropped');
});

test('metaError reads the code and survives a body that is not JSON', () => {
  assert.deepEqual(metaError('{"error":{"code":131049,"message":"nope","error_subcode":2494055}}'), {
    code: 131049,
    subcode: 2494055,
    message: 'nope',
    details: null,
  });
  assert.equal(metaError('<html>502</html>'), null);
  assert.equal(metaError('{"messages":[{"id":"x"}]}'), null);
  assert.equal(metaError(''), null);
});

// ------------------------------------------------------------- the mode switch

test('RADAR_DELIVER_MODE defaults to combined and refuses anything it does not know', () => {
  assert.deepEqual(DELIVER_MODES, ['combined', 'per-city']);
  assert.equal(cronConfig({}).deliverMode, 'combined');
  assert.equal(cronConfig({ RADAR_DELIVER_MODE: 'per-city' }).deliverMode, 'per-city');
  assert.equal(cronConfig({ RADAR_DELIVER_MODE: ' COMBINED ' }).deliverMode, 'combined');
  assert.throws(() => cronConfig({ RADAR_DELIVER_MODE: 'hourly' }), /RADAR_DELIVER_MODE must be one of: combined, per-city/);
});

// ---------------------------------------------------------------- the pass

/** A stub run: the city's own rows are written by the real run; here we only need what it hands the combiner. */
function fakeRun(byCity) {
  return async (opts) => {
    const cityKey = opts.city;
    if (byCity[cityKey] === 'fail') throw new Error(`${cityKey} source timed out`);
    const name = { bengaluru: 'Bengaluru', chennai: 'Chennai', mumbai: 'Mumbai' }[cityKey];
    const entry = cityEntry(name, byCity[cityKey]);
    return {
      runId: `run_${cityKey}`,
      summary: { leadsTotal: (byCity[cityKey].buyers || []).length, llm: null },
      // The real run delivers only what it was asked to deliver.
      delivered: (opts.deliver || []).map((channel) => ({ channel, sent: true, to: 'owner' })),
      delivery: entry,
    };
  };
}

test('in combined mode no city delivers, and one message goes out after the last city', async () => {
  const digestsDir = await tmp();
  const runsDir = await tmp();
  const sent = [];
  const events = [];
  const config = {
    cities: ['bengaluru', 'chennai', 'mumbai'],
    sources: ['overpass'],
    limit: 10,
    deliver: ['email', 'whatsapp'],
    deliverMode: 'combined',
  };
  const results = await runOnce(config, {
    log: () => {},
    date: TODAY,
    digestsDir,
    runsDir,
    runImpl: fakeRun({
      bengaluru: { requirements: [requirement('Bengaluru', 0)], buyers: [buyer('Bengaluru', 1)], prices: [price('Karnataka', 'Garlic', 7500, 'Binny Mill')] },
      chennai: { buyers: [buyer('Chennai', 2)], prices: [price('Tamil Nadu', 'Onion', 2200, 'Koyambedu')] },
      mumbai: 'fail',
    }),
    deliverImpl: async (channels, payload) => {
      sent.push({ channels: [...channels], payload });
      return channels.map((channel) => ({ channel, sent: true, to: 'owner', chars: payload.digestText.length, cities: payload.cities, via: 'text' }));
    },
    openStoreImpl: async () => ({ appendEvents: async (e) => events.push(...e), close: async () => {} }),
  });

  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  for (const r of results) assert.deepEqual(r.delivered || [], [], 'no city delivered on its own');

  assert.equal(sent.length, 1, 'exactly one delivery for the whole morning');
  assert.deepEqual(sent[0].channels, ['email', 'whatsapp']);
  assert.deepEqual(sent[0].payload.cities, ['Bengaluru', 'Chennai']);
  assert.match(sent[0].payload.digestText, /Not run today: Mumbai\./);
  assert.ok(sent[0].payload.fullSheet.includes('===== Bengaluru ====='));
  assert.equal(sent[0].payload.stats.leads, 2, 'the stats are the morning total, not one city');

  // One receipt per channel, each naming the cities it stood for.
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.type, 'digest.delivered');
    assert.deepEqual(e.cities, ['Bengaluru', 'Chennai']);
    assert.deepEqual(e.citiesFailed, ['Mumbai']);
  }
  const bundle = JSON.parse(await readFile(path.join(runsDir, `delivery_${TODAY}.evidence.json`), 'utf8'));
  assert.equal(bundle.receipts.filter((r) => r.type === 'digest.delivered').length, 2);
  assert.deepEqual(bundle.receipts[0].cities, ['Bengaluru', 'Chennai']);
});

test('a refused combined delivery is recorded with its error code, and the message is not lost', async () => {
  const digestsDir = await tmp();
  const runsDir = await tmp();
  const events = [];
  const { delivered } = await deliverCombined(
    [{ city: 'bengaluru', ok: true, delivery: cityEntry('Bengaluru', { buyers: [buyer('Bengaluru', 1)] }) }],
    {
      channels: ['whatsapp'],
      date: TODAY,
      digestsDir,
      runsDir,
      deliverImpl: async () => [
        {
          channel: 'whatsapp',
          sent: false,
          reason: 'not sent: WhatsApp API returned HTTP 400 (Meta error 131049: healthy ecosystem)',
          error: { code: 131049, message: 'healthy ecosystem' },
          file: `outbox/${TODAY}.whatsapp.json`,
        },
      ],
      openStoreImpl: async () => ({ appendEvents: async (e) => events.push(...e), close: async () => {} }),
    }
  );
  assert.equal(delivered[0].sent, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'digest.not_sent');
  assert.equal(events[0].errorCode, 131049);
  assert.deepEqual(events[0].cities, ['Bengaluru']);
  assert.equal(events[0].file, `outbox/${TODAY}.whatsapp.json`);
});

test('in per-city mode each run delivers its own digest, exactly as before', async () => {
  const sent = [];
  const config = {
    cities: ['bengaluru', 'chennai'],
    sources: ['overpass'],
    limit: 10,
    deliver: ['whatsapp'],
    deliverMode: 'per-city',
  };
  const results = await runOnce(config, {
    log: () => {},
    date: TODAY,
    runImpl: fakeRun({
      bengaluru: { buyers: [buyer('Bengaluru', 1)] },
      chennai: { buyers: [buyer('Chennai', 2)] },
    }),
    deliverImpl: async (channels, payload) => {
      sent.push(payload);
      return [];
    },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => (r.delivered || []).map((d) => d.channel)), [['whatsapp'], ['whatsapp']]);
  assert.equal(sent.length, 0, 'the pass sends nothing of its own in per-city mode');
  assert.equal(results.combined, undefined);
});

// ------------------------------------------------- what the owner reads back

test('the combined digest is what the dashboard and the owner\'s reply read back', async () => {
  const digestsDir = await tmp();
  const bengaluru = renderDigest([buyer('Bengaluru', 1)], { date: TODAY, city: 'Bengaluru' });
  bengaluru.priceSheet = renderPriceSheet([], { date: TODAY, state: 'Karnataka' });
  await writeDigest(bengaluru, TODAY, { digestsDir, cityKey: 'bengaluru' });
  const chennai = renderDigest([buyer('Chennai', 2)], { date: TODAY, city: 'Chennai' });
  chennai.priceSheet = renderPriceSheet([], { date: TODAY, state: 'Tamil Nadu' });
  await writeDigest(chennai, TODAY, { digestsDir, cityKey: 'chennai' });

  const combined = combineDigests(
    [cityEntry('Bengaluru', { buyers: [buyer('Bengaluru', 1)] }), cityEntry('Chennai', { buyers: [buyer('Chennai', 2)] })],
    { date: TODAY }
  );
  await writeCombinedDigest(combined, TODAY, { digestsDir });

  const latest = await latestDigest(digestsDir);
  assert.equal(latest.date, TODAY);
  assert.equal(latest.text.trim(), combined.text, 'the latest digest is the combined one, not the last city');

  // Each city still has its own digest on disk.
  const files = await readdir(digestsDir);
  assert.ok(files.includes(`${TODAY}.bengaluru.txt`));
  assert.ok(files.includes(`${TODAY}.chennai.txt`));
  assert.ok(files.includes(`${TODAY}.combined.txt`));
  const cityText = await readFile(path.join(digestsDir, `${TODAY}.chennai.txt`), 'utf8');
  assert.match(cityText, new RegExp(`${TITLE} - 2026-09-14 - Chennai`));
});

test('combineFromLeads builds the same combined digest from the store alone', () => {
  const leads = [
    requirement('Bengaluru', 0),
    buyer('Bengaluru', 1),
    buyer('Chennai', 2),
    price('Karnataka', 'Garlic', 7500, 'Binny Mill'),
  ];
  const combined = combineFromLeads(leads, { date: TODAY });
  assert.deepEqual(combined.cities, ['Bengaluru', 'Chennai']);
  assert.match(combined.text, /REQUIREMENTS POSTED/);
  assert.ok(combined.text.length <= DIGEST.maxChars);

  const only = combineFromLeads(leads, { date: TODAY, cities: ['Chennai'] });
  assert.deepEqual(only.cities, ['Chennai']);
  assert.ok(!only.text.includes('Bengaluru Fresh Produce'));
});
