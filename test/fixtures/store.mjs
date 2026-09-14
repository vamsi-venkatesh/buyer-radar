// A fixture store: the same interface openStore() returns, backed by arrays.
// Two weeks of leads, runs and events so the weekly report has a "last week"
// to compare against.

import { toLead } from '../../src/model.mjs';

const THIS_WEEK = '2026-09-09T06:00:00.000Z'; // Wednesday of 2026-W37
const LAST_WEEK = '2026-09-02T06:00:00.000Z'; // Wednesday of 2026-W36

function buyer(over = {}) {
  const { status, notes, score, first_seen, ...candidate } = over;
  const lead = toLead(
    {
      kind: 'buyer',
      segment: 'restaurant',
      name: 'Example Kitchen',
      city: 'Bengaluru',
      state: 'Karnataka',
      address: '1 Sampige Road, Bengaluru',
      phone: '+919845000001',
      source: 'overpass',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      licence: 'ODbL',
      externalId: 'node/1',
      ...candidate,
    },
    { nowIso: first_seen || THIS_WEEK }
  );
  if (status) lead.status = status;
  if (notes) lead.notes = notes;
  if (score !== undefined) lead.score = score;
  return lead;
}

function price({ commodity, market, modal, date, id }) {
  const lead = toLead(
    {
      kind: 'price',
      segment: 'other',
      name: `${commodity} - ${market}`,
      city: 'Bengaluru',
      state: 'Karnataka',
      source: 'agmarknet',
      sourceUrl: 'https://api.data.gov.in/resource/x?api-key=REDACTED',
      licence: 'data.gov.in (Government Open Data Licence - India)',
      externalId: id,
      whyNow: `mandi price ${date}`,
      whyNowDate: date,
      extra: { commodity, market, modalPrice: modal, arrivalDate: date, unit: 'INR per quintal' },
    },
    { nowIso: `${date}T06:00:00.000Z` }
  );
  return lead;
}

export const LEADS = [
  buyer({ externalId: 'node/1', name: 'Copper Chimney', segment: 'restaurant' }),
  buyer({ externalId: 'node/2', name: 'Hotel Sunrise', segment: 'hotel', phone: '+919845000002' }),
  buyer({ externalId: 'node/3', name: 'Hotel Moonrise', segment: 'hotel', phone: '+919845000003' }),
  buyer({ externalId: 'node/4', name: 'Chennai Grand', segment: 'hotel', city: 'Chennai', phone: '+919845000004' }),
  buyer({ externalId: 'node/5', name: 'Chennai Regency', segment: 'hotel', city: 'Chennai', phone: '+919845000005' }),
  buyer({
    externalId: 'node/6',
    name: 'Sri Venkateshwara Traders',
    segment: 'wholesale',
    phone: '+919845000006',
    status: 'contacted',
  }),
  buyer({
    externalId: 'node/7',
    name: 'Anand Caterers',
    segment: 'caterer',
    phone: '+919845000007',
    status: 'won',
  }),
  // No contact route at all.
  buyer({ externalId: 'node/8', name: 'Nameless Mess', phone: null, website: null }),
  // Found last week, so it must not be counted as found this week.
  buyer({ externalId: 'node/9', name: 'Old Lead', phone: '+919845000009', first_seen: LAST_WEEK }),
  // Prices: garlic in both weeks so a movement can be computed, tomato only this week.
  price({ commodity: 'Garlic', market: 'Bengaluru APMC', modal: 14000, date: '2026-09-09', id: 'g1' }),
  price({ commodity: 'Garlic', market: 'Binny Mill', modal: 15000, date: '2026-09-10', id: 'g2' }),
  price({ commodity: 'Garlic', market: 'Bengaluru APMC', modal: 12000, date: '2026-09-02', id: 'g3' }),
  price({ commodity: 'Tomato', market: 'Binny Mill', modal: 1600, date: '2026-09-09', id: 't1' }),
  price({ commodity: 'Tomato', market: 'Binny Mill', modal: 1800, date: '2026-09-10', id: 't2' }),
];

export const RUNS = [
  {
    id: 'run_20260909_aaaaaaaa',
    city: 'bengaluru',
    sources: ['overpass', 'news', 'cppp'],
    startedAt: '2026-09-09T01:30:00.000Z',
    finishedAt: '2026-09-09T01:31:00.000Z',
    dry: false,
    summary: {
      perSource: { overpass: { count: 120 }, news: { count: 40 }, cppp: { count: 0 } },
      blocked: [{ source: 'cppp', reason: 'captcha - the listing page requires an image captcha' }],
      candidates: 160,
      leadsTotal: 9,
    },
    bundleHash: 'a'.repeat(64),
  },
  {
    id: 'run_20260910_bbbbbbbb',
    city: 'bengaluru',
    sources: ['overpass'],
    startedAt: '2026-09-10T01:30:00.000Z',
    finishedAt: '2026-09-10T01:31:00.000Z',
    dry: false,
    summary: { perSource: { overpass: { count: 100 } }, blocked: [], candidates: 100, leadsTotal: 9 },
    bundleHash: 'b'.repeat(64),
  },
  // Last week's run, which the 2026-W37 report must not count.
  {
    id: 'run_20260902_cccccccc',
    city: 'bengaluru',
    sources: ['overpass'],
    startedAt: '2026-09-02T01:30:00.000Z',
    finishedAt: '2026-09-02T01:31:00.000Z',
    dry: false,
    summary: { perSource: { overpass: { count: 90 } }, blocked: [], candidates: 90, leadsTotal: 1 },
    bundleHash: 'c'.repeat(64),
  },
];

const wonLead = LEADS.find((l) => l.name === 'Anand Caterers');
const contactedLead = LEADS.find((l) => l.name === 'Sri Venkateshwara Traders');

export const EVENTS = [
  { seq: 0, type: 'lead.status_changed', at: '2026-09-09T09:00:00.000Z', leadId: contactedLead.id, from: 'new', to: 'contacted', runId: 'status_1' },
  { seq: 0, type: 'lead.status_changed', at: '2026-09-10T09:00:00.000Z', leadId: wonLead.id, from: 'contacted', to: 'won', runId: 'status_2' },
  // Last week's change must not appear in this week's counts.
  { seq: 0, type: 'lead.status_changed', at: '2026-09-02T09:00:00.000Z', leadId: contactedLead.id, from: 'new', to: 'lost', runId: 'status_0' },
  { seq: 1, type: 'run.created', at: '2026-09-09T01:30:00.000Z', runId: 'run_20260909_aaaaaaaa' },
];

/** Mutable in-memory store with the same shape openStore() returns. */
export function fixtureStore({ leads = LEADS, runs = RUNS, events = EVENTS, orders = [], llmCache = new Map(), llmSpend = new Map() } = {}) {
  let rows = leads.map((l) => ({ ...l }));
  const runRows = runs.map((r) => ({ ...r }));
  const eventRows = events.map((e) => ({ ...e }));
  const orderRows = orders.map((o) => ({ ...o }));
  return {
    kind: 'fixture',
    describe: () => 'fixture',
    async init() {},
    async allLeads() {
      return rows.map((l) => ({ ...l }));
    },
    async putLeads(next) {
      rows = next.map((l) => ({ ...l }));
    },
    async getLead(id) {
      const found = rows.find((l) => l.id === id);
      return found ? { ...found } : null;
    },
    async updateLead(id, patch) {
      const i = rows.findIndex((l) => l.id === id);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...patch };
      return { ...rows[i] };
    },
    async putRun(run) {
      runRows.push(run);
    },
    async allRuns() {
      return runRows.map((r) => ({ ...r }));
    },
    async allEvents() {
      return eventRows.map((e) => ({ ...e }));
    },
    async appendEvents(next) {
      eventRows.push(...next);
    },
    async hasEvent(kind, key) {
      if (!kind || !key) return false;
      return eventRows.some((e) => e.type === kind && e.key === key);
    },
    async allOrders() {
      return [...orderRows]
        .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
        .map((o) => ({ ...o }));
    },
    async getOrder(id) {
      const found = orderRows.find((o) => o.id === String(id));
      return found ? { ...found } : null;
    },
    async putOrder(order) {
      if (orderRows.some((o) => o.id === order.id)) return { inserted: false };
      orderRows.push({ ...order });
      return { inserted: true };
    },
    async updateOrder(id, patch) {
      const i = orderRows.findIndex((o) => o.id === String(id));
      if (i === -1) return null;
      orderRows[i] = { ...orderRows[i], ...patch };
      return { ...orderRows[i] };
    },
    // The LLM stage. Both maps survive a "restart" in a test by being handed
    // back to fixtureStore(), which is how the budget cap is proved to persist.
    async getLlmCache(key) {
      return llmCache.get(key) || null;
    },
    async putLlmCache(row) {
      llmCache.set(row.key, row);
    },
    async llmSpend(day) {
      return Number(llmSpend.get(day) || 0);
    },
    async addLlmSpend(day, amountInr) {
      const next = Math.round((Number(llmSpend.get(day) || 0) + Number(amountInr || 0)) * 10000) / 10000;
      llmSpend.set(day, next);
      return next;
    },
    tables: () => ({ llmCache, llmSpend }),
    async close() {},
  };
}
