#!/usr/bin/env node
// The service evaluation harness.
//
//   node tools/harness.mjs                 # run every case, write the results
//   node tools/harness.mjs --group scoring # one group
//   node tools/harness.mjs --quiet
//
// The case set is eval/harness/cases.json: a fixed list, each case with an id,
// a group, a description and an expected outcome. This file holds one check per
// case, and every check runs against the service's own modules. Nothing here
// reaches the network, calls a model or spends anything: the model lanes are
// driven by a stub fetch that answers from a queue and records what it was
// asked, and the stores are temporary directories thrown away at the end.
//
// Three verdicts, and only three:
//
//   pass            the check ran and the expectation held
//   fail            the check ran and it did not; the harness exits 1
//   not_applicable  the check could not be run, with the reason why
//
// A case that cannot be run is never reported as a pass. The model-quality
// group is the whole of that rule in practice: those thirty cases are not
// re-run here, their verdict is read from a recorded evaluation file, and when
// that file is not present they are not_applicable and say so.

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  toLead,
  scoreLead,
  upsertLeads,
  SEGMENT_POINTS,
} from '../src/model.mjs';
import { normalisePhone, todayIso } from '../src/lib/normalise.mjs';
import { extractContacts, findPhones, findEmails } from '../src/lib/contacts.mjs';
import { resolveSite } from '../src/llm/requirement.mjs';
import {
  renderDigest,
  renderPriceSheet,
  digestPlans,
  diversifyTies,
} from '../src/digest.mjs';
import { needsModel } from '../src/llm/needs.mjs';
import { createRunner } from '../src/llm/stage.mjs';
import { createCache } from '../src/llm/cache.mjs';
import { createBudget } from '../src/llm/budget.mjs';
import { loadPrompt } from '../src/llm/prompts.mjs';
import { parseEnrich } from '../src/llm/enrich.mjs';
import { llmSettings } from '../src/llm/settings.mjs';
import {
  ReceiptChain,
  bundleHash,
  verifyBundle,
  roleForReceipt,
  RECEIPT_ROLES,
} from '../src/lib/receipts.mjs';
import { callTool, dayReceipts, listTools } from '../src/tools/registry.mjs';
import { createJsonStore } from '../src/lib/store-json.mjs';
import { pgSafe } from '../src/lib/store-pg.mjs';
import { setLeadStatus } from '../src/register.mjs';
import {
  processWebhookBatch,
  handleWebhookRequest,
  webhookSummary,
  signBody,
  EVENT_INBOUND,
  EVENT_STATUS,
} from '../src/webhook.mjs';
import { fixtureStore, LEADS } from '../test/fixtures/store.mjs';
import { catalogueItems } from '../src/lib/catalogue.mjs';
import {
  EVIDENCE_SCHEMA,
  DIGEST,
  OVERPASS,
  CPPP,
  NEWS,
  AGMARKNET,
  INSTITUTIONS,
  GEM,
  OPENINGS,
  PUBLISHERS,
  REGISTRATIONS,
  EXPORTERS,
} from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CASES_FILE = path.join(ROOT, 'eval', 'harness', 'cases.json');
const RESULTS_DIR = path.join(ROOT, 'eval', 'harness', 'results');

// The one recorded evaluation this harness is allowed to read a verdict from.
// It is named here rather than guessed at, and when it is absent the
// model-quality cases say exactly that instead of borrowing another file's
// numbers.
const RECORDED_RESULT = path.join(ROOT, 'eval', 'llm', 'results', '2026-09-11.real.json');

const TODAY = '2026-09-11'; // a fixed clock: every scored case is dated against it
const OWNER = '919845000000'; // the fixtures' placeholder owner number
const STRANGER = '919000000001';

// ------------------------------------------------------------------ scratch

const scratch = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), `radar-harness-${prefix}-`));
  scratch.push(dir);
  return dir;
}
async function cleanScratch() {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ builders

function buyer(over = {}) {
  const { status, ...candidate } = over;
  const lead = toLead(
    {
      kind: 'buyer',
      segment: 'restaurant',
      name: 'Example Kitchen',
      city: 'Bengaluru',
      state: 'Karnataka',
      source: 'overpass',
      externalId: `node/${Math.random().toString(36).slice(2)}`,
      licence: 'ODbL',
      ...candidate,
    },
    { nowIso: `${TODAY}T06:00:00.000Z` }
  );
  if (status) lead.status = status;
  return lead;
}

/** A buyer stripped to one scoring input, so a band can be read on its own. */
function bare(over = {}) {
  return buyer({
    segment: 'other',
    city: 'Nowhere',
    state: 'Nowhere',
    phone: null,
    email: null,
    website: null,
    address: null,
    ...over,
  });
}

function requirement(over = {}) {
  const { status, extra = {}, ...candidate } = over;
  const lead = toLead(
    {
      kind: 'requirement',
      segment: 'institution',
      name: 'Hostel mess vegetable supply',
      city: 'Nowhere',
      state: 'Nowhere',
      source: 'institutions',
      licence: 'public tender notices',
      externalId: `notice/${Math.random().toString(36).slice(2)}`,
      ...candidate,
      extra,
    },
    { nowIso: `${TODAY}T06:00:00.000Z` }
  );
  if (status) lead.status = status;
  return lead;
}

function scoreOf(lead, over = {}) {
  return scoreLead(lead, { city: 'Bengaluru', state: 'Karnataka', todayIsoDate: TODAY, ...over });
}

/** A date `days` from TODAY, negative for the past. */
function dateFromToday(days) {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------ the model lane

const LLM_ENV = { DEEPSEEK_API_KEY: 'harness-key-never-used', LLM_MODEL: 'deepseek-chat' };

const ENRICH_ANSWER = JSON.stringify({
  segment: 'hotel',
  size: 'large',
  buys: ['vegetables'],
  quantity: '400 covers a day',
  deadline: null,
  evidence: ['We run two restaurants.'],
  confidence: 0.86,
});

function completion(content) {
  return {
    ok: true,
    status: 200,
    url: '',
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
  };
}

/** A fetch that answers from a queue and counts. It cannot reach anything. */
function stubFetch(replies = [completion(ENRICH_ANSWER)]) {
  const calls = [];
  const queue = [...replies];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  impl.calls = calls;
  return impl;
}

function refuseFetch() {
  const impl = async () => {
    throw new Error('the harness made a network call, which it must never do');
  };
  impl.calls = [];
  return impl;
}

// ------------------------------------------------------------ the checks

const CHECKS = {};
const check = (id, fn) => {
  CHECKS[id] = fn;
};

// ---------------------------------------------------------------- dedup

check('dedup-01', () => {
  const a = buyer({ name: 'Copper Chimney', phone: '080-41123456', externalId: 'a' });
  const b = buyer({ name: 'Copper Chimney Restaurant', phone: '+91 80 4112 3456', externalId: 'b' });
  const out = upsertLeads([], [a, b]);
  assert.equal(out.leads.length, 1);
  assert.equal(out.duplicateCount, 1);
  return { leads: out.leads.length, phone: out.leads[0].phone };
});

check('dedup-02', () => {
  const a = buyer({ name: 'Copper Chimney Pvt Ltd', phone: null, externalId: 'a' });
  const b = buyer({ name: 'The Copper Chimney Restaurant', phone: null, externalId: 'b' });
  const out = upsertLeads([], [a, b]);
  assert.equal(out.leads.length, 1);
  assert.equal(out.duplicateCount, 1);
  return { leads: out.leads.length };
});

check('dedup-03', () => {
  const a = buyer({ name: 'Copper Chimney', phone: null, city: 'Bengaluru', externalId: 'a' });
  const b = buyer({ name: 'Copper Chimney', phone: null, city: 'Chennai', externalId: 'b' });
  const out = upsertLeads([], [a, b]);
  assert.equal(out.leads.length, 2);
  assert.equal(out.duplicateCount, 0);
  return { leads: out.leads.length };
});

check('dedup-04', () => {
  const existing = buyer({ name: 'Copper Chimney', phone: '+919845000001', externalId: 'a' });
  existing.status = 'contacted';
  existing.notes = '2026-09-10 contacted: spoke to the purchase manager';
  const incoming = buyer({ name: 'Copper Chimney', phone: '+919845000001', externalId: 'b' });
  const out = upsertLeads([existing], [incoming]);
  assert.equal(out.leads.length, 1);
  assert.equal(out.leads[0].status, 'contacted');
  assert.equal(out.leads[0].notes, existing.notes);
  return { status: out.leads[0].status };
});

check('dedup-05', () => {
  const shared = { name: 'Karnataka Residential Hostel Society', phone: '+919845000010', city: 'Bengaluru' };
  const a = requirement({ ...shared, externalId: 'notice/1' });
  const b = requirement({ ...shared, externalId: 'notice/2' });
  const out = upsertLeads([], [a, b]);
  assert.equal(out.leads.length, 2, 'two notices from one body are two requirements');
  assert.equal(out.duplicateCount, 0);
  return { leads: out.leads.length };
});

// ---------------------------------------------------------------- scoring

for (const [segment, points] of Object.entries(SEGMENT_POINTS)) {
  check(`score-seg-${segment}`, () => {
    const { parts } = scoreOf(bare({ segment }));
    assert.equal(parts.segment, points);
    return { segment: parts.segment };
  });
}

const CONTACT_CASES = {
  phone: [{ phone: '+919845000001' }, 30],
  email: [{ email: 'purchase@example.in' }, 20],
  website: [{ website: 'https://example.in' }, 10],
  none: [{}, 0],
};
for (const [key, [over, points]] of Object.entries(CONTACT_CASES)) {
  check(`score-contact-${key}`, () => {
    const { parts } = scoreOf(bare(over));
    assert.equal(parts.contactability, points);
    return { contactability: parts.contactability };
  });
}

const RECENCY_CASES = {
  within14: [dateFromToday(-3), 20],
  within30: [dateFromToday(-20), 10],
  older: [dateFromToday(-60), 0],
  unknown: [null, 4],
};
for (const [key, [date, points]] of Object.entries(RECENCY_CASES)) {
  check(`score-recency-${key}`, () => {
    const { parts } = scoreOf(bare({ whyNowDate: date }));
    assert.equal(parts.recency, points);
    return { recency: parts.recency };
  });
}

check('score-city-match', () => {
  const { parts } = scoreOf(bare({ city: 'Bengaluru' }));
  assert.equal(parts.cityMatch, 10);
  return { cityMatch: parts.cityMatch };
});

check('score-city-miss', () => {
  const { parts } = scoreOf(bare({ city: 'Chennai' }));
  assert.equal(parts.cityMatch, 0);
  return { cityMatch: parts.cityMatch };
});

check('score-detail-full', () => {
  const { parts } = scoreOf(bare({ address: '1 Sampige Road, Bengaluru', extra: { lat: 12.97 } }));
  assert.equal(parts.detail, 10);
  return { detail: parts.detail };
});

check('score-detail-none', () => {
  const { parts } = scoreOf(bare());
  assert.equal(parts.detail, 0);
  return { detail: parts.detail };
});

check('score-penalty-worked', () => {
  const worked = bare({ status: 'contacted' });
  const fresh = bare();
  const a = scoreOf(worked);
  const b = scoreOf(fresh);
  assert.equal(a.parts.penalty, -25);
  assert.equal(b.parts.penalty, 0);
  return { penalty: a.parts.penalty, difference: b.score - a.score };
});

check('score-example-wholesale', () => {
  const lead = buyer({
    segment: 'wholesale',
    name: 'Sri Venkateshwara Traders',
    city: 'Bengaluru',
    phone: '+919845000006',
    address: '12 APMC Yard, Yeshwanthpur, Bengaluru',
    extra: { lat: 13.02, lon: 77.55 },
  });
  const { score, parts } = scoreOf(lead);
  assert.deepEqual(parts, { segment: 30, contactability: 30, recency: 4, cityMatch: 10, detail: 10, penalty: 0 });
  assert.equal(score, 84);
  return { score, parts };
});

check('score-example-restaurant', () => {
  const lead = buyer({
    segment: 'restaurant',
    name: 'Bhojan Ghar',
    city: 'Bengaluru',
    phone: null,
    address: null,
    whyNow: 'opening reported',
    whyNowDate: dateFromToday(-21),
  });
  const { score, parts } = scoreOf(lead);
  assert.deepEqual(parts, { segment: 30, contactability: 0, recency: 10, cityMatch: 10, detail: 0, penalty: 0 });
  assert.equal(score, 50);
  return { score, parts };
});

const DEADLINE_CASES = {
  within7: [dateFromToday(4), 30],
  within14: [dateFromToday(11), 25],
  within30: [dateFromToday(22), 18],
  later: [dateFromToday(60), 10],
  none: [null, 8],
  closed: [dateFromToday(-2), 0],
};
for (const [key, [deadline, points]] of Object.entries(DEADLINE_CASES)) {
  check(`score-deadline-${key}`, () => {
    const { parts } = scoreOf(requirement({ extra: deadline ? { deadline } : {} }));
    assert.equal(parts.deadline, points);
    return { deadline: parts.deadline };
  });
}

check('score-closed-not-live', () => {
  const shape = { phone: '+919845000011', city: 'Bengaluru', state: 'Karnataka' };
  const live = requirement({ ...shape, extra: { deadline: dateFromToday(4), quantityFit: 'within' } });
  const closed = requirement({ ...shape, extra: { deadline: dateFromToday(-2), quantityFit: 'within' } });
  const a = scoreOf(live);
  const b = scoreOf(closed);
  assert.equal(b.parts.deadline, 0, 'a closed notice scores nothing for its deadline');
  assert.equal(b.inputs.deadlineBand, 'closed');
  assert.ok(b.score < a.score, `closed ${b.score} must score below live ${a.score}`);
  return { live: a.score, closed: b.score };
});

const QUANTITY_CASES = { within: 25, unstated: 12, small: 8, over: 6 };
for (const [fit, points] of Object.entries(QUANTITY_CASES)) {
  check(`score-qty-${fit}`, () => {
    const { parts } = scoreOf(requirement({ extra: fit === 'unstated' ? {} : { quantityFit: fit } }));
    assert.equal(parts.quantityFit, points);
    return { quantityFit: parts.quantityFit };
  });
}

const REQ_CONTACT_CASES = {
  both: [{ phone: '+919845000012', email: 'stores@example.in' }, {}, 30],
  phone: [{ phone: '+919845000012' }, {}, 26],
  email: [{ email: 'stores@example.in' }, {}, 18],
  name: [{}, { contact_name: 'The Deputy Registrar' }, 6],
  none: [{}, {}, 0],
};
for (const [key, [fields, extra, points]] of Object.entries(REQ_CONTACT_CASES)) {
  check(`score-reqcontact-${key}`, () => {
    const { parts } = scoreOf(requirement({ ...fields, extra }));
    assert.equal(parts.contact, points);
    return { contact: parts.contact };
  });
}

const PLACE_CASES = {
  city: [{ city: 'Bengaluru', state: 'Karnataka' }, 15],
  state: [{ city: 'Mysuru', state: 'Karnataka' }, 8],
  elsewhere: [{ city: 'Hyderabad', state: 'Telangana' }, 0],
};
for (const [key, [where, points]] of Object.entries(PLACE_CASES)) {
  check(`score-place-${key}`, () => {
    const { parts } = scoreOf(requirement(where));
    assert.equal(parts.place, points);
    return { place: parts.place };
  });
}

check('score-example-requirement', () => {
  const lead = requirement({
    name: 'Hostel mess vegetable supply',
    city: 'Hyderabad',
    state: 'Telangana',
    phone: '+919845000013',
    email: 'stores@example.ac.in',
    extra: { deadline: dateFromToday(4), quantityFit: 'within' },
  });
  const { score, parts } = scoreOf(lead);
  assert.deepEqual(parts, { deadline: 30, quantityFit: 25, contact: 30, place: 0, penalty: 0 });
  assert.equal(score, 85);
  return { score, parts };
});

// ---------------------------------------------------------------- digest

function digestFixture() {
  const leads = [];
  for (let i = 0; i < 12; i += 1) {
    leads.push(
      buyer({
        name: `Buyer Number ${i}`,
        segment: i % 2 ? 'hotel' : 'restaurant',
        phone: `+9198450001${String(i).padStart(2, '0')}`,
        address: `${i} Sampige Road, Bengaluru`,
        externalId: `node/b${i}`,
      })
    );
  }
  for (let i = 0; i < 8; i += 1) {
    leads.push(
      requirement({
        name: `Requirement Number ${i}`,
        city: 'Bengaluru',
        state: 'Karnataka',
        phone: `+9198450002${String(i).padStart(2, '0')}`,
        externalId: `notice/r${i}`,
        extra: { requirement: 'Supply of fresh vegetables to the staff canteen', deadline: dateFromToday(5), quantityFit: 'within' },
      })
    );
  }
  return leads;
}

function pricesFixture() {
  return [
    toLead(
      {
        kind: 'price', segment: 'other', name: 'Garlic - Bengaluru APMC', city: 'Bengaluru', state: 'Karnataka',
        source: 'agmarknet', licence: AGMARKNET.licence, externalId: 'g1',
        extra: { commodity: 'Garlic', market: 'Bengaluru APMC', modalPrice: 14000, arrivalDate: TODAY, unit: 'INR per quintal' },
      },
      { nowIso: `${TODAY}T06:00:00.000Z` }
    ),
    toLead(
      {
        kind: 'price', segment: 'other', name: 'Tomato - Binny Mill', city: 'Bengaluru', state: 'Karnataka',
        source: 'agmarknet', licence: AGMARKNET.licence, externalId: 't1',
        extra: { commodity: 'Tomato', market: 'Binny Mill', modalPrice: 1600, arrivalDate: TODAY, unit: 'INR per quintal' },
      },
      { nowIso: `${TODAY}T06:00:00.000Z` }
    ),
  ];
}

check('digest-order-sections', () => {
  const result = renderDigest(digestFixture(), { date: TODAY, city: 'Bengaluru', prices: pricesFixture() });
  const req = result.text.indexOf('REQUIREMENTS POSTED');
  const buy = result.text.indexOf('BUYERS TO APPROACH');
  const prices = result.text.indexOf('Mandi prices');
  assert.ok(req >= 0 && buy >= 0 && prices >= 0, 'all three blocks are present');
  assert.ok(req < buy, 'requirements come before buyers');
  assert.ok(buy < prices, 'buyers come before prices');
  return { requirementsAt: req, buyersAt: buy, pricesAt: prices };
});

check('digest-cap-1500', () => {
  const leads = [];
  for (let i = 0; i < 60; i += 1) {
    leads.push(
      buyer({
        name: `A Very Long Trading Name For Buyer Number ${i}`,
        phone: `+9198450003${String(i).padStart(2, '0')}`,
        address: `${i} A Very Long Street Name, Bengaluru`,
        externalId: `node/c${i}`,
      })
    );
  }
  leads.push(...digestFixture());
  const result = renderDigest(leads, { date: TODAY, city: 'Bengaluru', prices: pricesFixture() });
  assert.ok(result.text.length <= DIGEST.maxChars, `${result.text.length} chars is over the ${DIGEST.maxChars} cap`);
  return { chars: result.text.length, cap: DIGEST.maxChars, shown: result.shown };
});

check('digest-no-phone-not-callable', () => {
  const lead = requirement({
    name: 'Canteen vegetable supply',
    city: 'Bengaluru',
    state: 'Karnataka',
    phone: null,
    email: null,
    externalId: 'notice/nocontact',
    extra: { requirement: 'Supply of fresh vegetables', deadline: dateFromToday(6) },
  });
  const result = renderDigest([lead], { date: TODAY, city: 'Bengaluru' });
  assert.match(result.text, /contact not found yet/);
  const line = result.text.split('\n').find((l) => l.includes('contact not found yet'));
  assert.ok(!/\d{6,}/.test(line), `a "no contact" line must carry nothing dialable: ${line}`);
  return { line: line.trim() };
});

check('digest-prices-last', () => {
  const result = renderDigest(digestFixture(), { date: TODAY, city: 'Bengaluru', prices: pricesFixture() });
  const prices = result.text.indexOf('Mandi prices');
  const footer = result.text.indexOf('Reply with');
  assert.ok(prices > result.text.indexOf('BUYERS TO APPROACH'));
  assert.ok(prices < footer, 'the price block sits above the reply footer');
  return { pricesAt: prices, footerAt: footer };
});

check('digest-price-sheet-every-item', () => {
  const sheet = renderPriceSheet(pricesFixture(), { date: TODAY, state: 'Karnataka' });
  const items = catalogueItems();
  const missing = items.filter((i) => !sheet.includes(`${i.label}`));
  assert.deepEqual(missing.map((i) => i.id), [], 'every catalogue item has a line');
  const priced = sheet.split('\n').filter((l) => /Rs \d/.test(l));
  assert.ok(priced.length > 0, 'at least one item is priced');
  for (const line of priced) {
    assert.match(line, /Rs \d+\/qtl/, `a priced line states the rate: ${line}`);
    assert.match(line, /\d{4}-\d{2}-\d{2}/, `a priced line states its arrival date: ${line}`);
  }
  return { items: items.length, pricedLines: priced.length };
});

check('digest-price-no-quote', () => {
  const sheet = renderPriceSheet(pricesFixture(), { date: TODAY, state: 'Karnataka' });
  const unpriced = catalogueItems().filter((i) => !i.commodity);
  assert.ok(unpriced.length > 0, 'the catalogue has items Agmarknet does not carry');
  for (const item of unpriced) {
    assert.ok(
      sheet.includes(`${item.label}: no mandi quote today`),
      `${item.label} must say "no mandi quote today", not a guessed price`
    );
  }
  return { unpriced: unpriced.length };
});

check('digest-plans-shed-order', () => {
  const plans = [...digestPlans({ requirements: 3, buyers: 3, registrations: 2 })];
  let sawRegistrationsShedFirst = false;
  for (const plan of plans) {
    if (plan.registrations < 2 && plan.buyers === 3 && plan.requirements === 3) sawRegistrationsShedFirst = true;
    if (plan.requirements < 3) {
      assert.equal(plan.buyers, 0, 'a requirement is dropped only after every buyer has gone');
      assert.equal(plan.registrations, 0, 'a requirement is dropped only after every registration has gone');
    }
  }
  assert.ok(sawRegistrationsShedFirst, 'registrations are shed while the other sections are still whole');
  return { plans: plans.length };
});

check('digest-ties-keep-score-order', () => {
  const leads = [
    buyer({ name: 'Hotel A', segment: 'hotel', externalId: 'x1' }),
    buyer({ name: 'Hotel B', segment: 'hotel', externalId: 'x2' }),
    buyer({ name: 'Wholesaler A', segment: 'wholesale', externalId: 'x3' }),
    buyer({ name: 'Retailer A', segment: 'retailer', externalId: 'x4' }),
  ];
  leads.forEach((l, i) => {
    l.score = [80, 80, 80, 60][i];
  });
  const sorted = [...leads].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const out = diversifyTies(sorted);
  assert.equal(out.length, sorted.length);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i - 1].score >= out[i].score, 'score order is never broken');
  }
  return { order: out.map((l) => l.score) };
});

// -------------------------------------------------------------- model gate

check('gate-enrich-directory-row', () => {
  const lead = buyer({ segment: 'wholesale', name: 'Sri Lakshmi Vegetables' });
  lead.score = 84;
  const d = needsModel('enrich', lead, { hasText: true, cacheHit: false, cutoff: 40 });
  assert.equal(d.needed, false);
  return { reason: d.reason };
});

check('gate-enrich-cache-hit', () => {
  const lead = buyer({ segment: 'other' });
  const d = needsModel('enrich', lead, { hasText: true, cacheHit: true, cutoff: 40 });
  assert.equal(d.needed, false);
  assert.match(d.reason, /cache/);
  return { reason: d.reason };
});

check('gate-enrich-missing-deadline', () => {
  const lead = requirement({ segment: 'institution', extra: {} });
  const d = needsModel('enrich', lead, { hasText: true, cacheHit: false, cutoff: 0 });
  assert.equal(d.needed, true);
  assert.match(d.reason, /closing date/);
  return { reason: d.reason };
});

check('gate-req-no-procurement-wording', () => {
  const text =
    'The new campus was inaugurated on Tuesday morning. The chief guest planted a sapling and the choir sang.';
  const d = needsModel('requirement', buyer({}), { hasText: true, text, deterministic: {} });
  assert.equal(d.needed, false);
  assert.equal(d.reason, 'no procurement wording');
  return { reason: d.reason };
});

check('gate-req-ambiguous-notice', () => {
  const text =
    'Sealed tenders are invited for the supply of fresh vegetables to the hostel mess. ' +
    'Quantity as required from time to time. Last date as notified on the board.';
  const d = needsModel('requirement', requirement({}), {
    hasText: true,
    text,
    deterministic: { quantity: null, deadline: null, contact: false },
  });
  assert.equal(d.needed, true);
  assert.match(d.reason, /no quantity, no closing date and no contact/);
  return { reason: d.reason };
});

check('gate-req-publisher-article', () => {
  const text =
    'The trust has floated a tender for the supply of vegetables to its two hostels, officials said.';
  const d = needsModel('requirement', buyer({}), {
    hasText: true,
    text,
    needsOrganisation: true,
    deterministic: { quantity: '1,500 kg', deadline: '2026-09-30', contact: true },
  });
  assert.equal(d.needed, true, 'an article needs the model whatever a regex read off it');
  assert.match(d.reason, /publisher article/);
  return { reason: d.reason };
});

check('gate-cache-hit-no-call', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('harness_cache');
  const fetchImpl = stubFetch([completion(ENRICH_ANSWER)]);
  const runner = createRunner({
    store,
    chain,
    settings: llmSettings(LLM_ENV),
    day: TODAY,
    fetchImpl,
    env: LLM_ENV,
  });
  const ask = () =>
    runner.ask({
      purpose: 'enrich',
      prompt: loadPrompt('enrich'),
      input: 'one page of text, asked twice',
      maxTokens: 600,
      jsonMode: true,
      parse: parseEnrich,
    });
  const first = await ask();
  const second = await ask();
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(fetchImpl.calls.length, 1, 'the second ask made no call');
  assert.equal(runner.totals().cacheHits, 1);
  assert.equal(chain.receipts.filter((r) => r.type === 'llm.cache_hit').length, 1);
  return { calls: fetchImpl.calls.length, cacheHits: runner.totals().cacheHits };
});

check('gate-budget-exhausted-receipt', async () => {
  const store = fixtureStore();
  const chain = new ReceiptChain('harness_budget');
  const fetchImpl = refuseFetch();
  const runner = createRunner({
    store,
    chain,
    settings: { ...llmSettings(LLM_ENV), dailyBudgetInr: 0 },
    day: TODAY,
    fetchImpl,
    env: LLM_ENV,
  });
  const answer = await runner.ask({
    purpose: 'enrich',
    prompt: loadPrompt('enrich'),
    input: 'a page the budget will not pay to read',
    maxTokens: 600,
    jsonMode: true,
    parse: parseEnrich,
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'budget');
  assert.equal(fetchImpl.calls.length, 0, 'nothing was called');
  const receipt = chain.receipts.find((r) => r.type === 'llm.budget_exhausted');
  assert.ok(receipt, 'the refusal left a receipt');
  assert.equal(receipt.capInr, 0);
  assert.equal(receipt.role, 'reader');
  assert.equal(runner.totals().budgetSkipped, 1);
  return { receipt: receipt.type, capInr: receipt.capInr, calls: fetchImpl.calls.length };
});

// -------------------------------------------------------------- owner gate

/** A digest on disk with an index, so R/L/G refs resolve. */
async function digestsOnDisk(index) {
  const dir = await tempDir('digests');
  await writeFile(path.join(dir, `${TODAY}.txt`), 'Buyer Radar - 2026-09-11\n\nL3 Copper Chimney - restaurant\n');
  await writeFile(path.join(dir, `${TODAY}.prices.txt`), 'Mandi price sheet - 2026-09-11\nPeeled garlic: Rs 14000/qtl\n');
  await writeFile(path.join(dir, `${TODAY}.index.json`), `${JSON.stringify(index, null, 2)}\n`);
  return dir;
}

function inboundBody(messages = [], statuses = []) {
  return Buffer.from(
    JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages, statuses } }] }] }),
    'utf8'
  );
}

function textMessage({ id, from, body }) {
  return { id, from, timestamp: '1757568000', type: 'text', text: { body } };
}

/** Everything processWebhookBatch needs, with a fetch that records replies. */
async function webhookCtx({ store, index } = {}) {
  const digestsDir = await digestsOnDisk(index || { L3: LEADS[0].id });
  const runsDir = await tempDir('runs');
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: `wamid.reply${sent.length}` }] }),
    };
  };
  const shared = store || fixtureStore({ events: [] });
  return {
    sent,
    store: shared,
    ctx: {
      env: { RADAR_TO_WA: OWNER, WA_FAKE_FETCH_URL: 'http://127.0.0.1:0/fake-cloud-api' },
      storeFactory: async () => shared,
      digestsDir,
      runsDir,
      fetchImpl,
      date: TODAY,
    },
  };
}

check('owner-digest-reply', async () => {
  const { ctx, sent } = await webhookCtx();
  const out = await processWebhookBatch(
    inboundBody([textMessage({ id: 'wamid.owner1', from: OWNER, body: 'digest please' })]),
    ctx
  );
  assert.equal(out.inbound, 1);
  assert.equal(sent.length, 1, 'exactly one reply');
  assert.equal(sent[0].body.to, OWNER);
  assert.match(sent[0].body.text.body, /Buyer Radar - 2026-09-11/);
  return { replies: sent.length, chars: sent[0].body.text.body.length };
});

check('owner-stranger-recorded-never-answered', async () => {
  const { ctx, sent, store } = await webhookCtx();
  const out = await processWebhookBatch(
    inboundBody([textMessage({ id: 'wamid.stranger1', from: STRANGER, body: 'what are your rates?' })]),
    ctx
  );
  assert.equal(out.inbound, 1, 'it was recorded');
  assert.equal(sent.length, 0, 'and never answered');
  const events = await store.allEvents();
  const inbound = events.find((e) => e.type === EVENT_INBOUND && e.key === 'wamid.stranger1');
  assert.ok(inbound, 'one event line for the inbound message');
  assert.equal(inbound.owner, false);
  assert.equal(inbound.text, null, "a buyer's words are not stored");
  return { inbound: out.inbound, replies: sent.length, storedText: inbound.text };
});

check('owner-command-l3-won', async () => {
  const lead = LEADS.find((l) => l.name === 'Copper Chimney');
  const store = fixtureStore({ events: [] });
  const { ctx, sent } = await webhookCtx({ store, index: { L3: lead.id } });
  const out = await processWebhookBatch(
    inboundBody([textMessage({ id: 'wamid.cmd1', from: OWNER, body: 'L3 won' })]),
    ctx
  );
  assert.equal(out.commands.length, 1);
  assert.equal(out.commands[0].ok, true, out.commands[0].error);
  assert.equal(out.commands[0].to, 'won');
  const after = await store.getLead(lead.id);
  assert.equal(after.status, 'won');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text.body, /Receipt [0-9a-f]{12}/);
  return { status: after.status, from: out.commands[0].from };
});

check('owner-duplicate-wamid', async () => {
  const lead = LEADS.find((l) => l.name === 'Copper Chimney');
  const store = fixtureStore({ events: [] });
  const { ctx, sent } = await webhookCtx({ store, index: { L3: lead.id } });
  const body = inboundBody([textMessage({ id: 'wamid.dup1', from: OWNER, body: 'L3 contacted' })]);
  const first = await processWebhookBatch(body, ctx);
  const second = await processWebhookBatch(body, ctx);
  assert.equal(first.inbound, 1);
  assert.equal(second.inbound, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(sent.length, 1, 'the redelivery is not answered again');
  const after = await store.getLead(lead.id);
  assert.equal(after.status, 'contacted');
  const noteLines = String(after.notes || '').split('\n').filter(Boolean);
  assert.ok(noteLines.length <= 1, 'the command was applied once');
  return { duplicates: second.duplicates, replies: sent.length };
});

/** A local server that serves exactly the webhook route. Nothing else listens. */
async function webhookServer(env) {
  const runsDir = await tempDir('runs');
  const store = fixtureStore({ events: [] });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    handleWebhookRequest(req, res, {
      env,
      url,
      storeFactory: async () => store,
      runsDir,
      date: TODAY,
    }).catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = (raw, headers = {}) =>
    new Promise((resolve, reject) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/webhook',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.write(buf);
      req.end();
    });
  return { post, close: () => new Promise((r) => server.close(r)) };
}

check('owner-bad-hmac-401', async () => {
  const { post, close } = await webhookServer({ WA_APP_SECRET: 'harness-app-secret', RADAR_TO_WA: OWNER });
  try {
    const body = inboundBody([textMessage({ id: 'wamid.bad1', from: OWNER, body: 'digest' })]);
    const res = await post(body, { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` });
    assert.equal(res.status, 401);
    assert.match(res.text, /invalid X-Hub-Signature-256/);
    const good = await post(body, { 'X-Hub-Signature-256': signBody(body, 'harness-app-secret') });
    assert.equal(good.status, 200, 'the same body with the right signature is accepted');
    return { bad: res.status, good: good.status };
  } finally {
    await close();
  }
});

check('owner-missing-secret-503', async () => {
  const { post, close } = await webhookServer({ RADAR_TO_WA: OWNER });
  try {
    const body = inboundBody([textMessage({ id: 'wamid.nosecret', from: OWNER, body: 'digest' })]);
    const res = await post(body, { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` });
    assert.equal(res.status, 503);
    assert.match(res.text, /WA_APP_SECRET is not set/);
    return { status: res.status };
  } finally {
    await close();
  }
});

check('owner-24h-131047', async () => {
  const { ctx, store } = await webhookCtx();
  const out = await processWebhookBatch(
    inboundBody(
      [],
      [
        {
          id: 'wamid.out1',
          status: 'failed',
          timestamp: '1757568000',
          recipient_id: OWNER,
          errors: [
            {
              code: 131047,
              title: 'Re-engagement message',
              error_data: { details: 'Message failed to send because more than 24 hours have passed.' },
            },
          ],
        },
      ]
    ),
    ctx
  );
  assert.equal(out.statuses, 1);
  const events = await store.allEvents();
  const failed = events.find((e) => e.type === EVENT_STATUS && e.status === 'failed');
  assert.ok(failed, 'the failure is an event, not a silence');
  assert.equal(failed.error.code, 131047);
  const summary = webhookSummary(events);
  assert.match(summary.lastFailure.line, /131047/);
  return { code: failed.error.code, lastFailure: summary.lastFailure.line };
});

check('owner-only-tool-refused-for-agent', async () => {
  const runsDir = await tempDir('runs');
  const receipts = dayReceipts({ runsDir, date: TODAY });
  const calls = [];
  receipts.add = ((orig) => (type, data) => {
    calls.push({ type, data });
    return orig(type, data);
  })(receipts.add.bind(receipts));
  const res = await callTool(
    'owner.message',
    { text: 'this must never be sent' },
    { store: fixtureStore(), actor: 'agent', env: { RADAR_TO_WA: OWNER }, receipts, runsDir }
  );
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.equal(calls.filter((c) => c.type === 'tool.refused').length, 1);
  assert.equal(calls.filter((c) => c.type === 'tool.call').length, 0, 'a refused tool is never called');
  assert.equal(calls[0].data.role, 'owner');
  return { refused: res.refused, reason: res.error };
});

// ---------------------------------------------------------------- verifier

check('verify-publisher-site-refused', () => {
  const refused = [];
  for (const host of ['https://timesofindia.indiatimes.com/story', 'https://www.google.com/search?q=x', 'https://www.facebook.com/somebody']) {
    const r = resolveSite(host);
    assert.equal(r.ok, false, `${host} must be refused`);
    refused.push({ host, reason: r.reason });
  }
  assert.match(refused[0].reason, /refused host/);
  return { refused };
});

check('verify-own-site-accepted', () => {
  const r = resolveSite('https://www.example-hospital.ac.in/about');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.host, 'www.example-hospital.ac.in');
  assert.equal(r.url, 'https://www.example-hospital.ac.in');
  return { url: r.url };
});

check('verify-phone-no-country-code-assumed', () => {
  // Nine digits is not padded up to ten and eleven is not trimmed down to it:
  // both are refused, because a wrong number is worse than no number.
  assert.equal(normalisePhone('984500000'), null, 'nine digits must not be completed into a number');
  assert.equal(normalisePhone('98450000012'), null, 'eleven digits must not be trimmed into one');
  // +91 is only ever written where ten digits were actually there to write it on.
  assert.equal(normalisePhone('9845000001'), '+919845000001');
  assert.equal(normalisePhone('+91 98450 00001'), '+919845000001');
  assert.equal(normalisePhone('0091 98450 00001'), '+919845000001');
  assert.equal(normalisePhone('+1 415 555 0100'), null, 'a number that is not Indian is stored as nothing, never relabelled +91');
  return {
    nine: normalisePhone('984500000'),
    eleven: normalisePhone('98450000012'),
    ten: normalisePhone('9845000001'),
  };
});

check('verify-portal-helpdesk-dropped', () => {
  const text = 'For any difficulty contact eproc@nic.in. Buyer queries: stores@example.ac.in';
  const emails = findEmails(text).map((e) => e.email);
  assert.ok(!emails.includes('eproc@nic.in'), 'the portal helpdesk is not the buyer');
  assert.ok(emails.includes('stores@example.ac.in'), "the buyer's own address survives");
  return { emails };
});

check('verify-date-not-a-phone', () => {
  const text = 'Last date 22.05.2024\n1\n5\nOpening 25.05.2024';
  const phones = findPhones(text);
  assert.deepEqual(phones.map((p) => p.phone), [], `a table of dates yielded ${JSON.stringify(phones)}`);
  const contacts = extractContacts(text);
  assert.equal(contacts.phone, null);
  return { phones: phones.length };
});

check('verify-licence-on-every-lead', () => {
  const configs = {
    overpass: OVERPASS.licence,
    cppp: CPPP.licence,
    news: NEWS.licence,
    agmarknet: AGMARKNET.licence,
    institutions: INSTITUTIONS.licence,
    gem: GEM.licence,
    openings: OPENINGS.licence,
    publishers: PUBLISHERS.licence,
    registrations: REGISTRATIONS.licence,
    exporters: EXPORTERS.licence,
  };
  for (const [source, licence] of Object.entries(configs)) {
    assert.equal(typeof licence, 'string', `${source} states no licence`);
    assert.ok(licence.trim().length > 0, `${source} states an empty licence`);
    const lead = toLead(
      { kind: 'buyer', segment: 'other', name: 'Example', source, externalId: '1', licence },
      { nowIso: `${TODAY}T06:00:00.000Z` }
    );
    assert.equal(lead.licence, licence, `${source} lost its licence on the way to the register`);
  }
  return { sources: Object.keys(configs).length };
});

// ---------------------------------------------------------------- receipts

const SAMPLE_RECEIPTS = [
  { seq: 0, type: 'run.created', at: '2026-09-11T06:00:00.000Z', role: 'auditor', runId: 'run_h', city: 'bengaluru' },
  { seq: 1, type: 'source.fetched', at: '2026-09-11T06:00:10.000Z', role: 'scout', source: 'overpass', count: 42 },
  { seq: 2, type: 'llm.call', at: '2026-09-11T06:00:11.000Z', role: 'reader', purpose: 'enrich', costInr: 0.12 },
  { seq: 3, type: 'digest.rendered', at: '2026-09-11T06:00:12.000Z', role: 'desk', chars: 900 },
  { seq: 4, type: 'evidence.sealed', at: '2026-09-11T06:00:13.000Z', role: 'auditor', runId: 'run_h', receiptCount: 4 },
];

function sampleBundle() {
  return {
    schema: EVIDENCE_SCHEMA,
    runId: 'run_h',
    sealedAt: '2026-09-11T06:00:13.000Z',
    receiptCount: SAMPLE_RECEIPTS.length,
    hash: bundleHash(SAMPLE_RECEIPTS),
    receipts: SAMPLE_RECEIPTS,
  };
}

check('receipt-hash-recipe', () => {
  let payload = `${EVIDENCE_SCHEMA}\n${SAMPLE_RECEIPTS.length}\n`;
  for (const r of SAMPLE_RECEIPTS) payload += `${JSON.stringify(r)}\n`;
  const expected = createHash('sha256').update(payload, 'utf8').digest('hex');
  assert.equal(bundleHash(SAMPLE_RECEIPTS), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
  return { hash: expected };
});

check('receipt-order-in-hash', () => {
  const swapped = [...SAMPLE_RECEIPTS];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.notEqual(bundleHash(swapped), bundleHash(SAMPLE_RECEIPTS));
  return { same: false };
});

function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

check('receipt-verify-good-bundle', async () => {
  const dir = await tempDir('bundles');
  const file = path.join(dir, 'good.evidence.json');
  await writeFile(file, `${JSON.stringify(sampleBundle(), null, 2)}\n`, 'utf8');
  const res = await runNode([path.join('tools', 'verify.mjs'), file]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /VERIFIED/);
  return { exitCode: res.code };
});

check('receipt-verify-tampered-bundle', async () => {
  const dir = await tempDir('bundles');
  const file = path.join(dir, 'tampered.evidence.json');
  const bundle = sampleBundle();
  bundle.receipts = bundle.receipts.map((r, i) => (i === 1 ? { ...r, count: 43 } : r));
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const res = await runNode([path.join('tools', 'verify.mjs'), file]);
  assert.equal(res.code, 1, 'a tampered bundle must not verify');
  assert.match(res.stdout, /hash mismatch/);
  assert.match(res.stdout, /FAILED/);
  const local = verifyBundle(bundle);
  assert.equal(local.ok, false);
  return { exitCode: res.code };
});

check('receipt-role-on-every-receipt', async () => {
  // Every receipt type run.mjs emits, through the chain the run uses.
  const chain = new ReceiptChain('run_roles');
  const runTypes = [
    'run.created', 'source.fetched', 'source.blocked', 'llm.disabled', 'llm.call', 'llm.cache_hit',
    'llm.not_needed', 'llm.budget_exhausted', 'llm.error', 'llm.invalid_output', 'llm.page_skipped',
    'llm.enriched', 'llm.opener', 'openings.skipped', 'openings.finished', 'openings.awareness_only',
    'openings.article_read', 'openings.not_a_requirement', 'openings.no_site', 'openings.contact_search',
    'openings.upgraded', 'leads.upserted', 'digest.rendered', 'digest.delivered', 'digest.not_sent',
  ];
  for (const type of runTypes) chain.add(type, {});
  const bundle = chain.seal();
  for (const r of bundle.receipts) {
    assert.ok(RECEIPT_ROLES.includes(r.role), `${r.type} has role ${JSON.stringify(r.role)}`);
  }
  assert.equal(roleForReceipt('source.fetched'), 'scout');
  assert.equal(roleForReceipt('llm.call'), 'reader');
  assert.equal(roleForReceipt('openings.contact_search'), 'verifier');
  assert.equal(roleForReceipt('digest.rendered'), 'desk');
  assert.equal(roleForReceipt('whatsapp.command'), 'owner');
  assert.equal(roleForReceipt('evidence.sealed'), 'auditor');

  // And the tool layer, which states its own role per tool.
  const runsDir = await tempDir('runs');
  await callTool('leads.search', { limit: 5 }, { store: fixtureStore(), actor: 'agent', runsDir });
  const toolBundle = JSON.parse(await readFile(path.join(runsDir, `tools_${todayIso()}.evidence.json`), 'utf8'));
  for (const r of toolBundle.receipts) {
    assert.ok(RECEIPT_ROLES.includes(r.role), `${r.type} has role ${JSON.stringify(r.role)}`);
  }
  const call = toolBundle.receipts.find((r) => r.type === 'tool.call');
  assert.equal(call.role, 'desk');
  for (const t of listTools()) {
    assert.ok(RECEIPT_ROLES.includes(t.role), `${t.name} declares ${t.role}`);
  }
  return { runReceipts: bundle.receipts.length, toolReceipts: toolBundle.receipts.length };
});

// ---------------------------------------------------------------- memory

check('memory-status-across-runs', async () => {
  const dataDir = await tempDir('data');
  const runsDir = await tempDir('runs');
  const digestsDir = await digestsOnDisk({ L1: 'unused' });
  const lead = buyer({ name: 'Copper Chimney', phone: '+919845000001', externalId: 'node/persist' });

  const first = createJsonStore({ dataDir });
  await first.init();
  await first.putLeads([lead]);
  await first.close();

  const second = createJsonStore({ dataDir });
  await second.init();
  await setLeadStatus(second, { ref: lead.id, status: 'won', note: 'first order', digestsDir, runsDir });
  await second.close();

  const third = createJsonStore({ dataDir });
  await third.init();
  const back = await third.getLead(lead.id);
  await third.close();

  assert.equal(back.status, 'won');
  assert.match(back.notes, /won: first order/);
  return { status: back.status };
});

check('memory-pgsafe-nul', () => {
  const NUL = '\u0000';
  const dirty = { name: `Copper${NUL} Chimney`, extra: { note: [`a${NUL}b`] } };
  const clean = pgSafe(dirty);
  assert.equal(JSON.stringify(clean).includes('\\u0000'), false);
  assert.equal(clean.name, 'Copper Chimney');
  assert.equal(clean.extra.note[0], 'ab');
  return { name: clean.name };
});

check('memory-pgsafe-lone-surrogate', () => {
  const lone = `before \uD800 after`;
  const pair = `keep 😀 this`;
  assert.equal(pgSafe(lone), 'before  after');
  assert.equal(pgSafe(pair), pair, 'a valid surrogate pair survives');
  return { stripped: pgSafe(lone), kept: pgSafe(pair) };
});

check('memory-spend-across-restart', async () => {
  const dataDir = await tempDir('data');
  const first = createJsonStore({ dataDir });
  await first.init();
  const budgetA = createBudget(first, { day: TODAY, capInr: 10 });
  await budgetA.record(9.999);
  await first.close();

  const second = createJsonStore({ dataDir });
  await second.init();
  const budgetB = createBudget(second, { day: TODAY, capInr: 10 });
  const spent = await budgetB.spent();
  const decision = await budgetB.check({ model: 'deepseek-chat', inputTokens: 4000, outputTokens: 600 });
  await second.close();

  assert.equal(spent, 9.999, 'the restart resumed the same day total');
  assert.equal(decision.allowed, false, 'and the cap still holds');
  return { spent, cap: decision.cap, allowed: decision.allowed };
});

check('memory-cache-across-restart', async () => {
  const dataDir = await tempDir('data');
  const parts = { provider: 'deepseek', model: 'deepseek-chat', promptVersion: 'enrich/test', input: 'one page of text' };

  const first = createJsonStore({ dataDir });
  await first.init();
  await createCache(first).put(parts, ENRICH_ANSWER, { at: `${TODAY}T06:00:00.000Z` });
  await first.close();

  const second = createJsonStore({ dataDir });
  await second.init();
  const chain = new ReceiptChain('harness_cache_restart');
  const fetchImpl = refuseFetch();
  const runner = createRunner({ store: second, chain, settings: llmSettings(LLM_ENV), day: TODAY, fetchImpl, env: LLM_ENV });
  const answer = await runner.ask({
    purpose: 'enrich',
    prompt: { version: 'enrich/test', body: 'unused, the answer is already cached' },
    input: parts.input,
    maxTokens: 600,
    jsonMode: true,
    parse: parseEnrich,
  });
  await second.close();

  assert.equal(answer.ok, true);
  assert.equal(answer.cacheHit, true);
  assert.equal(fetchImpl.calls.length, 0, 'a cached answer costs nothing');
  return { cacheHit: answer.cacheHit, segment: answer.value.segment };
});

// ------------------------------------------------------- model quality

/**
 * The thirty labelled pages are not re-run here. Their verdict is read from a
 * recorded evaluation result, and if that file is not in the repository the
 * cases are not applicable and say which file was looked for. A recorded number
 * nobody can point at is not a measurement.
 */
let recorded = null;
let recordedProblem = null;
if (existsSync(RECORDED_RESULT)) {
  try {
    recorded = JSON.parse(readFileSync(RECORDED_RESULT, 'utf8'));
  } catch (err) {
    recordedProblem = `${path.relative(ROOT, RECORDED_RESULT)} could not be read: ${err.message}`;
  }
} else {
  recordedProblem =
    `the recorded real-lane result this group reads from, ${path.relative(ROOT, RECORDED_RESULT)}, is not in this repository. ` +
    'The only recorded evaluation present is eval/llm/results/2026-09-11.stub.json, which is the keyword-stub lane - ' +
    'its own summary says it measures the harness and not the model, and its numbers ' +
    '(segment 93.3%, size 70.0%, deadline 100%, JSON validity 100%) are not the ones this case set was written against. ' +
    'Nothing is read from it, and no verdict is invented.';
}

function recordedVerdict(caseId) {
  const fixtureId = caseId.replace(/^mq-/, '');
  if (!recorded) return { verdict: 'not_applicable', reason: recordedProblem };
  const row = (recorded.summary?.perCase || []).find((r) => r.id === fixtureId);
  if (!row) {
    return {
      verdict: 'not_applicable',
      reason: `${path.relative(ROOT, RECORDED_RESULT)} records no result for ${fixtureId}`,
    };
  }
  const fields = Object.entries(row.fields || {});
  const wrong = fields.filter(([, f]) => !f.correct).map(([name, f]) => `${name}: expected ${f.expected}, answered ${f.actual}`);
  return {
    verdict: row.ok && !wrong.length ? 'pass' : 'fail',
    // A failure has to say what was wrong with it. Without this the results
    // table printed "undefined" in the column that is meant to hold the reason.
    reason: wrong.length ? wrong.join('; ') : row.ok ? null : 'the recorded run marked this case not ok',
    detail: {
      source: path.relative(ROOT, RECORDED_RESULT),
      lane: recorded.meta?.lane ?? null,
      ok: Boolean(row.ok),
      wrong,
    },
  };
}

// ------------------------------------------------------------------ runner

function loadCases() {
  const doc = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  if (!Array.isArray(doc.cases) || !doc.cases.length) throw new Error(`${CASES_FILE} holds no cases`);
  return doc;
}

/** Every executed case must have a check, and every check must have a case. */
function reconcile(cases) {
  const ids = new Set(cases.map((c) => c.id));
  const missing = cases.filter((c) => c.provenance === 'executed' && !CHECKS[c.id]).map((c) => c.id);
  const orphans = Object.keys(CHECKS).filter((id) => !ids.has(id));
  if (missing.length || orphans.length) {
    const parts = [];
    if (missing.length) parts.push(`cases with no check: ${missing.join(', ')}`);
    if (orphans.length) parts.push(`checks with no case: ${orphans.join(', ')}`);
    throw new Error(`the case set and the harness disagree - ${parts.join('; ')}`);
  }
}

// Per-case timings are kept here rather than on the result, so re-running the
// harness on an unchanged tree writes a byte-identical file: a results artifact
// that churns on wall-clock noise cannot be diffed to see what moved.
const timings = new Map();

async function runCase(c) {
  if (c.provenance === 'recorded') {
    const out = recordedVerdict(c.id);
    return { ...c, ...out };
  }
  const started = Date.now();
  try {
    const detail = await CHECKS[c.id]();
    timings.set(c.id, Date.now() - started);
    return { ...c, verdict: 'pass', detail: detail ?? null };
  } catch (err) {
    timings.set(c.id, Date.now() - started);
    if (err && err.notApplicable) {
      return { ...c, verdict: 'not_applicable', reason: err.message };
    }
    return {
      ...c,
      verdict: 'fail',
      reason: err && err.message ? err.message.split('\n')[0] : String(err),
      error: `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`,
    };
  }
}

function summarise(results, groups) {
  const byGroup = {};
  for (const g of groups) byGroup[g] = { group: g, cases: 0, pass: 0, fail: 0, not_applicable: 0 };
  for (const r of results) {
    if (!byGroup[r.group]) byGroup[r.group] = { group: r.group, cases: 0, pass: 0, fail: 0, not_applicable: 0 };
    byGroup[r.group].cases += 1;
    byGroup[r.group][r.verdict] += 1;
  }
  return {
    cases: results.length,
    pass: results.filter((r) => r.verdict === 'pass').length,
    fail: results.filter((r) => r.verdict === 'fail').length,
    not_applicable: results.filter((r) => r.verdict === 'not_applicable').length,
    groups: Object.values(byGroup),
  };
}

function toMarkdown(doc, results, summary, date) {
  const lines = [
    `# ${doc.title}`,
    '',
    `- Date: ${date}`,
    `- Case set: eval/harness/cases.json (${summary.cases} cases)`,
    `- Verdicts: **${summary.pass} pass, ${summary.fail} fail, ${summary.not_applicable} not applicable**`,
    '- Every executed case runs against the service\'s own modules with local fixtures. No network call, no model call, nothing spent.',
    '',
    '| Group | Cases | Pass | Fail | N/A |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...summary.groups.map((g) => `| ${g.group} | ${g.cases} | ${g.pass} | ${g.fail} | ${g.not_applicable} |`),
    '',
  ];

  const failed = results.filter((r) => r.verdict === 'fail');
  if (failed.length) {
    lines.push('## Failures', '', '| Case | Expected | What happened |', '| --- | --- | --- |');
    for (const r of failed) lines.push(`| ${r.id} | ${r.expected} | ${r.reason} |`);
    lines.push('');
  }

  const na = results.filter((r) => r.verdict === 'not_applicable');
  if (na.length) {
    const reasons = new Map();
    for (const r of na) {
      if (!reasons.has(r.reason)) reasons.set(r.reason, []);
      reasons.get(r.reason).push(r.id);
    }
    lines.push('## Not applicable', '');
    for (const [reason, ids] of reasons) {
      lines.push(`**${ids.length} case${ids.length === 1 ? '' : 's'}** - ${reason}`, '', `${ids.join(', ')}`, '');
    }
  }

  lines.push('## Every case', '', '| Case | Group | Verdict | Expected |', '| --- | --- | --- | --- |');
  for (const r of results) lines.push(`| ${r.id} | ${r.group} | ${r.verdict} | ${r.expected} |`);
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { group: null, quiet: false, date: todayIso() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--group') out.group = String(argv[++i] || '');
    else if (argv[i] === '--quiet') out.quiet = true;
    else if (argv[i] === '--date') out.date = String(argv[++i] || '');
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

export async function runHarness({ group = null } = {}) {
  const doc = loadCases();
  reconcile(doc.cases);
  const cases = group ? doc.cases.filter((c) => c.group === group) : doc.cases;
  if (!cases.length) throw new Error(`no cases in group ${JSON.stringify(group)}`);
  const results = [];
  try {
    for (const c of cases) results.push(await runCase(c));
  } finally {
    await cleanScratch();
  }
  return { doc, results, summary: summarise(results, doc.groups) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { doc, results, summary } = await runHarness(opts);
  await mkdir(RESULTS_DIR, { recursive: true });
  const stem = path.join(RESULTS_DIR, opts.date);
  const payload = {
    schema: doc.schema,
    service: doc.service,
    title: doc.title,
    date: opts.date,
    recordedSource: recorded ? path.relative(ROOT, RECORDED_RESULT) : null,
    recordedProblem: recorded ? null : recordedProblem,
    summary,
    results,
  };
  await writeFile(`${stem}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const md = toMarkdown(doc, results, summary, opts.date);
  await writeFile(`${stem}.md`, md, 'utf8');

  if (!opts.quiet) {
    for (const r of results) {
      if (r.verdict === 'pass') continue;
      process.stdout.write(`${r.verdict.toUpperCase().padEnd(14)} ${r.id}  ${r.reason || ''}\n`);
    }
    process.stdout.write(
      `\n${summary.cases} cases: ${summary.pass} pass, ${summary.fail} fail, ${summary.not_applicable} not applicable\n`
    );
    for (const g of summary.groups) {
      process.stdout.write(
        `  ${g.group.padEnd(14)} ${String(g.cases).padStart(3)} cases  ${g.pass} pass  ${g.fail} fail  ${g.not_applicable} n/a\n`
      );
    }
    process.stderr.write(`\nwritten: ${path.relative(process.cwd(), stem)}.json and .md\n`);
  }
  process.exit(summary.fail > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    await cleanScratch();
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(2);
  });
}
