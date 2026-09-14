// The tool layer: schema validation before the handler, a receipt per call, and
// the two gates that decide what an agent may do.

import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validate } from '../src/tools/schema.mjs';
import { listTools, getTool, callTool, dayReceipts, TOOLS, KINDS_OF_TOOL, COSTS } from '../src/tools/registry.mjs';
import { verifyBundle } from '../src/lib/receipts.mjs';
import { fixtureStore, LEADS } from './fixtures/store.mjs';

const DAY = '2026-09-11';

/** A receipts sink that keeps everything in memory, so a test can read it. */
function sink() {
  const entries = [];
  return {
    entries,
    add(type, data = {}) {
      entries.push({ type, ...data });
      return { type, ...data };
    },
    of(type) {
      return entries.filter((e) => e.type === type);
    },
  };
}

function ctx(over = {}) {
  return { store: fixtureStore(), env: {}, actor: 'agent', receipts: sink(), now: () => `${DAY}T06:00:00.000Z`, ...over };
}

// ---------------------------------------------------------------- the schema

test('the validator fills defaults, refuses unknown fields and names the field it refused', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['new', 'won'] },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
  };
  assert.deepEqual(validate({ status: 'won' }, schema).value, { status: 'won', limit: 5 });
  assert.equal(validate({ status: 'maybe' }, schema).ok, false);
  assert.match(validate({ status: 'new', limit: 99 }, schema).errors[0], /above the maximum 10/);
  assert.match(validate({ status: 'new', sneak: 1 }, schema).errors[0], /unknown field "sneak"/);
  assert.match(validate({}, schema).errors[0], /"status" is required/);
  assert.match(validate({ status: 'new', limit: 'three' }, schema).errors[0], /expected integer, got string/);
});

test('a default is copied, never shared between calls', () => {
  const schema = { type: 'object', properties: { items: { type: 'array', default: [] } } };
  const a = validate({}, schema).value;
  a.items.push('x');
  assert.deepEqual(validate({}, schema).value.items, [], 'the second call gets its own array');
});

// ---------------------------------------------------------------- the registry

test('every tool declares a kind, a cost and both schemas', () => {
  assert.ok(TOOLS.length >= 11);
  for (const t of listTools()) {
    assert.ok(KINDS_OF_TOOL.includes(t.kind), `${t.name} kind`);
    assert.ok(COSTS.includes(t.cost), `${t.name} cost`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} input schema`);
    assert.ok(t.outputSchema, `${t.name} output schema`);
    assert.ok(t.description.length > 20, `${t.name} description`);
  }
  assert.equal(getTool('leads.search').kind, 'read');
  assert.equal(getTool('model.read').cost, 'metered');
  assert.equal(getTool('nope'), null);
});

test('bad input is refused before the handler runs, and the refusal is receipted', async () => {
  const c = ctx();
  let handlerRan = false;
  const original = getTool('leads.get').handler;
  getTool('leads.get').handler = async (...args) => {
    handlerRan = true;
    return original(...args);
  };
  try {
    const res = await callTool('leads.get', { id: 7 }, c);
    assert.equal(res.ok, false);
    assert.equal(handlerRan, false, 'the handler never saw the bad input');
    assert.match(res.error, /invalid input for leads\.get: id: expected string/);
  } finally {
    getTool('leads.get').handler = original;
  }
  const receipt = c.receipts.of('tool.call')[0];
  assert.equal(receipt.ok, false);
  assert.equal(receipt.name, 'leads.get');
  assert.match(receipt.error, /expected string/);
});

test('an unknown tool is an error with a receipt, not a throw', async () => {
  const c = ctx();
  const res = await callTool('leads.delete_everything', {}, c);
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown tool/);
  assert.equal(c.receipts.of('tool.call')[0].kind, null);
});

test('every invocation appends a tool.call receipt with the hashes and the timing', async () => {
  const c = ctx();
  const res = await callTool('leads.search', { limit: 3 }, c);
  assert.equal(res.ok, true);
  assert.equal(res.output.leads.length, 3);
  const receipt = c.receipts.of('tool.call')[0];
  assert.equal(receipt.name, 'leads.search');
  assert.equal(receipt.kind, 'read');
  assert.equal(receipt.ok, true);
  assert.equal(typeof receipt.ms, 'number');
  assert.match(receipt.inputHash, /^[0-9a-f]{16}$/);
  assert.match(receipt.outputHash, /^[0-9a-f]{16}$/);
  assert.equal(receipt.error, undefined);
});

test('a call outside a run writes a per-day tools bundle that verifies', async (t) => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-tools-'));
  await callTool('contacts.extract', { text: 'Contact: Dr Anita Rao, +91 98450 12345' }, { store: fixtureStore(), env: {}, runsDir });
  await callTool('contacts.extract', { text: 'office.admin@iith.ac.in' }, { store: fixtureStore(), env: {}, runsDir });

  const files = (await readdir(runsDir)).filter((f) => f.startsWith('tools_'));
  assert.equal(files.length, 1, 'one bundle per day, appended to');
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.equal(bundle.receipts.filter((r) => r.type === 'tool.call').length, 2);
  assert.deepEqual(
    bundle.receipts.map((r) => r.seq),
    bundle.receipts.map((_, i) => i),
    'appending keeps the sequence numbers'
  );
});

// ---------------------------------------------------------------- the gates

test('an agent cannot set a status and cannot message the owner; the owner can', async () => {
  const asAgent = ctx();
  const refusedStatus = await callTool('leads.set_status', { id: LEADS[0].id, status: 'contacted' }, asAgent);
  assert.equal(refusedStatus.ok, false);
  assert.equal(refusedStatus.refused, true);
  assert.match(refusedStatus.error, /owner-only/);

  const refusedMessage = await callTool('owner.message', { text: 'anything' }, asAgent);
  assert.equal(refusedMessage.refused, true);
  const refusals = asAgent.receipts.of('tool.refused');
  assert.deepEqual(refusals.map((r) => r.name), ['leads.set_status', 'owner.message']);
  assert.equal(refusals[0].actor, 'agent');
  assert.equal(asAgent.receipts.of('tool.call').length, 0, 'a refused tool is never called');

  // The lead did not move.
  const after = await callTool('leads.get', { id: LEADS[0].id }, asAgent);
  assert.equal(after.output.lead.status, 'new');
});

test('the owner can set a status, and it writes the same receipt the CLI writes', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-status-'));
  const digestsDir = await mkdtemp(path.join(tmpdir(), 'radar-digests-'));
  await writeFile(path.join(digestsDir, `${DAY}.index.json`), JSON.stringify({ L1: LEADS[0].id }));
  const c = ctx({ actor: 'owner', runsDir, digestsDir });

  const res = await callTool('leads.set_status', { ref: 'L1', status: 'contacted', note: 'spoke to the purchase manager' }, c);
  assert.equal(res.ok, true);
  assert.equal(res.output.from, 'new');
  assert.equal(res.output.to, 'contacted');
  assert.equal(res.output.resolvedVia, `${DAY}.index.json`);
  assert.match(res.output.receiptHash, /^[0-9a-f]{64}$/);

  const bundle = JSON.parse(await readFile(res.output.receiptFile, 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.equal(bundle.receipts[0].type, 'lead.status_changed');
  assert.equal(bundle.receipts[0].note, 'spoke to the purchase manager');

  const after = await callTool('leads.get', { id: LEADS[0].id }, c);
  assert.equal(after.output.lead.status, 'contacted');
});

test('the pipeline itself is allowed through the gate without being the owner', async () => {
  const c = ctx({ actor: 'agent', system: true, runsDir: await mkdtemp(path.join(tmpdir(), 'radar-sys-')) });
  const res = await callTool('leads.set_status', { id: LEADS[1].id, status: 'quoted' }, c);
  assert.equal(res.ok, true);
  assert.equal(res.output.to, 'quoted');
});

test('owner.message has no recipient field at all, and says where it went without printing the number', async () => {
  assert.equal(getTool('owner.message').inputSchema.properties.to, undefined);
  const c = ctx({ actor: 'owner', env: { RADAR_TO_WA: '+919845000000', WA_FAKE_FETCH_URL: 'http://127.0.0.1:1/none' } });
  const res = await callTool('owner.message', { text: 'digest' }, c);
  assert.equal(res.ok, true);
  assert.equal(res.output.sent, false, 'nothing is listening, so it reports not sent');
  assert.equal(res.output.to, '…0000');

  const noNumber = await callTool('owner.message', { text: 'digest' }, ctx({ actor: 'owner' }));
  assert.match(noNumber.output.reason, /RADAR_TO_WA unset/);
});

// ---------------------------------------------------------------- read tools

test('leads.search filters, searches by name and phone digits, and reports the totals', async () => {
  const c = ctx();
  const hotels = await callTool('leads.search', { segment: 'hotel', limit: 50 }, c);
  assert.equal(hotels.output.leads.every((l) => l.segment === 'hotel'), true);
  assert.equal(hotels.output.matched, hotels.output.leads.length);

  const byName = await callTool('leads.search', { query: 'copper' }, c);
  assert.deepEqual(byName.output.leads.map((l) => l.name), ['Copper Chimney']);

  const byPhone = await callTool('leads.search', { query: '000002' }, c);
  assert.deepEqual(byPhone.output.leads.map((l) => l.name), ['Hotel Sunrise']);

  const capped = await callTool('leads.search', { limit: 2 }, c);
  assert.equal(capped.output.count, 2);
  assert.ok(capped.output.matched > 2, 'the cap does not hide how many matched');
  assert.equal(capped.output.total, LEADS.length);
});

test('prices.get reads stored readings only and names what has none', async () => {
  const c = ctx();
  const res = await callTool('prices.get', { days: 30 }, c);
  assert.equal(res.ok, true);
  assert.ok(res.output.rows.length >= 4);
  assert.equal(res.output.rows[0].date >= res.output.rows[1].date, true, 'newest first');
  for (const row of res.output.rows) assert.equal(row.unit, 'INR per quintal');
  assert.ok(
    res.output.withoutReading.some((line) => /no mandi line|no stored reading/.test(line)),
    'an item with no reading is named, not zeroed'
  );

  const garlic = await callTool('prices.get', { items: ['peeled-garlic'], days: 30 }, c);
  assert.equal(garlic.output.rows.every((r) => r.commodity === 'Garlic'), true, 'a catalogue id maps to its Agmarknet commodity');
});

test('digest.render composes text and writes nothing', async (t) => {
  const c = ctx();
  const res = await callTool('digest.render', { date: DAY, city: 'Bengaluru' }, c);
  assert.equal(res.ok, true);
  assert.match(res.output.text, new RegExp(`${CLIENT.digest.title} - 2026-09-11`));
  assert.ok(res.output.priceSheet.includes('Mandi price sheet'));
  assert.ok(Object.keys(res.output.index).length > 0);
});

test('digest.render combined renders the one message the morning pass sends', async () => {
  const c = ctx();
  const res = await callTool('digest.render', { date: DAY, combined: true }, c);
  assert.equal(res.ok, true);
  assert.equal(res.output.combined, true);
  assert.ok(res.output.cities.length > 0, 'it names the cities it combined');
  assert.match(res.output.text, new RegExp(`${CLIENT.digest.title} - 2026-09-11`));
  assert.equal(res.output.text.split('Mandi prices (INR/quintal):').length - 1 <= 1, true, 'prices at most once');
});

test('contacts.extract is the same reader the demand lane uses', async () => {
  const c = ctx();
  const res = await callTool(
    'contacts.extract',
    { text: 'Contact Person: Dr Anita Rao, Deputy Registrar (Stores)\nPhone: 040-2301 6773\nEmail: office.admin [at] iith [dot] ac [dot] in' },
    c
  );
  assert.equal(res.output.phone, '+914023016773');
  assert.equal(res.output.email, 'office.admin@iith.ac.in');
  assert.equal(res.output.name, 'Dr Anita Rao');
  assert.equal(res.output.complete, true);
});

test('pdf.text reads base64 bytes and refuses what is not a PDF', async () => {
  const c = ctx();
  const pdf = await readFile(new URL('./fixtures/pdf-notice-uncompressed.pdf', import.meta.url));
  const ok = await callTool('pdf.text', { bytes: pdf.toString('base64') }, c);
  assert.equal(ok.output.ok, true);
  assert.ok(ok.output.chars > 0);

  const notPdf = await callTool('pdf.text', { bytes: Buffer.from('hello').toString('base64') }, c);
  assert.equal(notPdf.output.ok, false);
  assert.match(notPdf.output.reason, /not a PDF/);

  const neither = await callTool('pdf.text', {}, c);
  assert.equal(neither.ok, false);
  assert.match(neither.error, /needs url or bytes/);
});

test('web.fetch obeys robots.txt and reports the rule rather than the page', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/robots.txt')) {
      return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('<title>Traders</title><p>We buy vegetables daily.</p>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  const c = ctx({ fetch: fetchImpl });
  const { createPageFetcher } = await import('../src/llm/page.mjs');
  const pageFetcher = createPageFetcher({ fetchImpl, sleep: async () => {} });

  const allowed = await callTool('web.fetch', { url: 'https://traders.example/about' }, { ...c, pageFetcher });
  assert.equal(allowed.output.ok, true);
  assert.match(allowed.output.text, /We buy vegetables daily/);
  assert.equal(allowed.output.title, 'Traders');

  const refused = await callTool('web.fetch', { url: 'https://traders.example/private/x' }, { ...c, pageFetcher });
  assert.equal(refused.output.ok, false);
  assert.match(refused.output.reason, /robots\.txt disallows/);
  assert.equal(calls.filter((u) => u.includes('/private')).length, 0, 'a disallowed page is never requested');
});

test('model.read is off with no key and refuses a call the rules say is unnecessary', async () => {
  const offline = await callTool('model.read', { purpose: 'enrich', text: 'a page' }, ctx());
  assert.equal(offline.output.ok, false);
  assert.match(offline.output.reason, /the model stage is off/);

  const c = ctx({ env: { DEEPSEEK_API_KEY: 'sk-test' } });
  const lead = LEADS[0]; // segment restaurant, not a requirement, so nothing to learn
  const skipped = await callTool('model.read', { purpose: 'enrich', text: 'a page about it', leadId: lead.id }, c);
  assert.equal(skipped.output.needed, false);
  assert.match(skipped.output.reason, /the source already gave a segment/);
  assert.equal(c.receipts.of('llm.not_needed').length, 1);
  assert.equal(c.receipts.of('llm.call').length, 0, 'nothing was spent');
});

// ---------------------------------------------------------------- the sink

test('dayReceipts flushes nothing when nothing was recorded', async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-empty-'));
  const r = dayReceipts({ runsDir, date: DAY });
  assert.equal(await r.flush(), null);
  assert.deepEqual(await readdir(runsDir), []);
});
