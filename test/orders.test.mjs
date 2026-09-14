// The order loop: the client's site -> the automation layer -> POST /orders ->
// the register -> the owner.
//
// Nothing here touches the network. The Cloud API is a local recorder reached
// through WA_FAKE_FETCH_URL, the SMTP server is the fake one on node:net, and
// the store is the in-memory fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/dashboard/server.mjs';
import {
  normaliseOrder,
  recordOrder,
  alertOwner,
  alertText,
  alertLabel,
  matchLead,
  orderLines,
  whyNowFromOrder,
  ordersToCsv,
  segmentFromBusinessType,
  ORDER_LICENCE,
  ORDER_SITE,
  WINDOW_CLOSED_CODE,
} from '../src/orders.mjs';
import { callTool } from '../src/tools/registry.mjs';
import { matchOrderCommand, lastMatchedLeadId, whenWebhookIdle, signBody } from '../src/webhook.mjs';
import { alertFailedLater } from '../src/orders.mjs';
import { collectReport } from '../src/report.mjs';
import { verifyBundle } from '../src/lib/receipts.mjs';
import { fixtureStore, LEADS } from './fixtures/store.mjs';
import { startFakeSmtp } from './fixtures/fake-smtp.mjs';

const TOKEN = 'test-owner-token-0123456789';
const ORDERS_KEY = 'orders-key-for-the-test-0123456789012345';
const OWNER = '919845000000';

/** The exact envelope the client's site posts, with the fields it posts. */
function siteOrder(over = {}) {
  return {
    eventType: 'order.created',
    eventId: '11111111-2222-3333-4444-555555555555',
    occurredAt: '2026-09-14T05:00:00.000Z',
    source: 'greenfieldproduce.example',
    order: {
      orderId: 'ORD-TEST0001',
      createdAt: '2026-09-14T05:00:00.000Z',
      status: 'new-awaiting-confirmation',
      contactName: 'Test Buyer',
      businessName: 'Radar Loop Test Kitchen',
      phone: '+91 98450 11111',
      email: 'buyer@example.test',
      city: 'Bengaluru',
      businessType: 'Restaurant',
      products: ['Peeled garlic', 'Broccoli'],
      orderDetails: 'Peeled garlic 20 kg\nBroccoli 5 kg',
      schedule: 'Weekly',
      neededBy: '2026-09-20',
      notes: 'Deliver before 7am.',
      sourcePath: '/order',
      ...(over.order || {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'order')),
  };
}

/** A local recorder standing in for graph.facebook.com. Records, never forwards. */
async function fakeCloudApi(t, { ok = true, body = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      calls.push({ headers: req.headers, body: text });
      if (ok) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: `wamid.order${calls.length}` }] }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, url: `http://127.0.0.1:${server.address().port}/messages` };
}

const WINDOW_CLOSED_BODY = {
  error: {
    message: '(#131047) Re-engagement message',
    code: WINDOW_CLOSED_CODE,
    error_data: { details: 'Message failed to send because more than 24 hours have passed since the customer last replied.' },
  },
};

async function tmpRuns() {
  return mkdtemp(path.join(tmpdir(), 'radar-orders-runs-'));
}

/** The dashboard over a fixture store, with the orders key set for this test. */
async function withServer(t, { store = fixtureStore(), env = {} } = {}) {
  const digestsDir = await mkdtemp(path.join(tmpdir(), 'radar-digests-'));
  const runsDir = await tmpRuns();
  await writeFile(path.join(digestsDir, '2026-09-10.txt'), 'Buyer Radar - 2026-09-10\n\nL1 Copper Chimney\n');

  const saved = {};
  const applied = { RADAR_ORDERS_KEY: ORDERS_KEY, RADAR_TO_WA: OWNER, ...env };
  for (const [k, v] of Object.entries(applied)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const server = createServer({ token: TOKEN, digestsDir, runsDir, storeFactory: async () => store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const request = (p, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  const postOrder = (payload, { key = ORDERS_KEY, raw } = {}) =>
    request('/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { 'x-farmquick-automation-key': key }),
      },
      body: raw ?? JSON.stringify(payload),
    });

  const auth = (p) => request(p, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { request, postOrder, auth, store, runsDir, digestsDir, port };
}

// ------------------------------------------------------------------ shape

test('the site envelope and a bare order both normalise to the same record', () => {
  const fromEnvelope = normaliseOrder(siteOrder(), { receivedAt: '2026-09-14T05:00:01.000Z' });
  const fromBare = normaliseOrder(siteOrder().order, { receivedAt: '2026-09-14T05:00:01.000Z' });
  assert.equal(fromEnvelope.id, 'ORD-TEST0001');
  assert.equal(fromEnvelope.frequency, 'Weekly', 'the site calls it schedule; the register calls it frequency');
  assert.deepEqual(fromEnvelope.products, ['Peeled garlic', 'Broccoli']);
  assert.equal(fromEnvelope.email, 'buyer@example.test');
  assert.equal(fromBare.id, fromEnvelope.id);
  assert.equal(fromBare.orderDetails, fromEnvelope.orderDetails);
});

test('a body that is not an order is refused by name, not silently dropped', () => {
  assert.throws(() => normaliseOrder({ order: { contactName: 'x' } }), /missing orderId, orderDetails or products/);
  assert.throws(() => normaliseOrder({ order: { orderId: 'ORD-1' } }), /missing orderDetails or products/);
});

test('the lines, the why_now and the segment come off the order itself', () => {
  const order = normaliseOrder(siteOrder());
  assert.deepEqual(orderLines(order), ['Peeled garlic, Broccoli', 'Peeled garlic 20 kg', 'Broccoli 5 kg']);
  assert.equal(whyNowFromOrder(order), 'Ordered on 2026-09-14: Peeled garlic, Broccoli; Peeled garlic 20 kg; Broccoli 5 kg');
  assert.equal(segmentFromBusinessType('Restaurant'), 'restaurant');
  assert.equal(segmentFromBusinessType('Hotel / resort'), 'hotel');
  assert.equal(segmentFromBusinessType('Something else entirely'), 'other');
});

test("the owner's message carries everything he needs to ring the buyer back", () => {
  const text = alertText(normaliseOrder(siteOrder()));
  for (const needle of ['ORD-TEST0001', 'Radar Loop Test Kitchen', 'Bengaluru', '+91 98450 11111', 'Peeled garlic 20 kg', 'Weekly', 'Deliver before 7am.']) {
    assert.ok(text.includes(needle), `the alert should carry ${needle}`);
  }
  assert.ok(text.includes('no payment has been taken'), 'the alert must not imply the order is accepted');
});

// ------------------------------------------------------------------ the endpoint

test('POST /orders is 503 when RADAR_ORDERS_KEY is unset', async (t) => {
  const { postOrder } = await withServer(t, { env: { RADAR_ORDERS_KEY: null } });
  const res = await postOrder(siteOrder());
  assert.equal(res.status, 503);
  assert.match(res.text, /RADAR_ORDERS_KEY is not set/);
});

test('POST /orders is 401 without the key and 401 with the wrong one', async (t) => {
  const { postOrder } = await withServer(t);
  const missing = await postOrder(siteOrder(), { key: null });
  assert.equal(missing.status, 401);
  assert.match(missing.text, /is missing/);
  const wrong = await postOrder(siteOrder(), { key: `${ORDERS_KEY}x` });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /does not match/);
});

test('POST /orders is 400 on a body that is not JSON and on one that is not an order', async (t) => {
  const { postOrder } = await withServer(t);
  const notJson = await postOrder(null, { raw: '{' });
  assert.equal(notJson.status, 400);
  assert.match(notJson.text, /body is not JSON/);
  const notOrder = await postOrder({ order: { contactName: 'nobody' } });
  assert.equal(notOrder.status, 400);
  assert.match(notOrder.text, /not an order/);
});

test('a new order is recorded, the buyer is created as a won lead, and it all verifies', async (t) => {
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const { postOrder, runsDir } = await withServer(t, {
    store,
    env: { WA_FAKE_FETCH_URL: fake.url, WA_TOKEN: 'test-token', WA_PHONE_NUMBER_ID: '1' },
  });

  const res = await postOrder(siteOrder());
  assert.equal(res.status, 201);
  const answer = JSON.parse(res.text);
  assert.equal(answer.duplicate, false);
  assert.equal(answer.orderId, 'ORD-TEST0001');
  assert.equal(answer.leadCreated, true);
  assert.equal(answer.status, 'won');
  assert.equal(answer.alert.channel, 'whatsapp');

  const orders = await store.allOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, 'ORD-TEST0001');
  assert.equal(orders[0].leadId, answer.leadId);

  const lead = await store.getLead(answer.leadId);
  assert.equal(lead.status, 'won');
  assert.equal(lead.kind, 'buyer');
  assert.equal(lead.segment, 'restaurant');
  assert.equal(lead.source, 'site-order');
  assert.equal(lead.licence, ORDER_LICENCE);
  assert.equal(lead.phone, '+919845011111');
  assert.match(lead.why_now, /^Ordered on 2026-09-14: /);
  assert.equal(lead.extra.orders.length, 1);
  assert.equal(lead.extra.orders[0].orderId, 'ORD-TEST0001');

  const events = await store.allEvents();
  const received = events.filter((e) => e.type === 'order.received');
  const won = events.filter((e) => e.type === 'lead.won');
  const alerted = events.filter((e) => e.type === 'order.alert');
  assert.equal(received.length, 1);
  assert.equal(received[0].orderId, 'ORD-TEST0001');
  assert.equal(won.length, 1);
  assert.equal(won[0].to, 'won');
  assert.equal(alerted.length, 1);
  assert.equal(alerted[0].channel, 'whatsapp');

  // One message, to the owner's own number, and nothing to the buyer.
  assert.equal(fake.calls.length, 1);
  const sent = JSON.parse(fake.calls[0].body);
  assert.equal(sent.to, OWNER);
  assert.ok(sent.text.body.includes('ORD-TEST0001'));
  assert.ok(!sent.text.body.includes('buyer@example.test'), 'the buyer is never a recipient');

  const files = (await readdir(runsDir)).filter((f) => f.startsWith('orders_'));
  assert.equal(files.length, 1);
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.ok(bundle.receipts.some((r) => r.type === 'order.received' && r.role === 'desk'));
});

test('a replayed order reference changes nothing and tells nobody twice', async (t) => {
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const { postOrder } = await withServer(t, {
    store,
    env: { WA_FAKE_FETCH_URL: fake.url, WA_TOKEN: 'test-token', WA_PHONE_NUMBER_ID: '1' },
  });

  const first = await postOrder(siteOrder());
  assert.equal(first.status, 201);
  const again = await postOrder(siteOrder());
  assert.equal(again.status, 200);
  const answer = JSON.parse(again.text);
  assert.equal(answer.duplicate, true);
  assert.equal(answer.orderId, 'ORD-TEST0001');

  assert.equal((await store.allOrders()).length, 1);
  assert.equal((await store.allEvents()).filter((e) => e.type === 'order.received').length, 1);
  assert.equal(fake.calls.length, 1, 'a replay must not message the owner a second time');
  const lead = await store.getLead(answer.leadId);
  assert.equal(lead.extra.orders.length, 1, 'the order is on the lead once');
});

test('an order from a number already in the register moves that lead to won instead of creating one', async (t) => {
  const existing = LEADS.find((l) => l.name === 'Copper Chimney');
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const { postOrder } = await withServer(t, {
    store,
    env: { WA_FAKE_FETCH_URL: fake.url, WA_TOKEN: 'test-token', WA_PHONE_NUMBER_ID: '1' },
  });

  const before = (await store.allLeads()).length;
  const res = await postOrder(
    siteOrder({ order: { orderId: 'ORD-TEST0002', phone: '+91 98450 00001', businessName: 'Copper Chimney' } })
  );
  assert.equal(res.status, 201);
  const answer = JSON.parse(res.text);
  assert.equal(answer.leadCreated, false);
  assert.equal(answer.matchedOn, 'phone');
  assert.equal(answer.leadId, existing.id);
  assert.equal((await store.allLeads()).length, before, 'no second row for a buyer already held');

  const lead = await store.getLead(existing.id);
  assert.equal(lead.status, 'won');
  assert.equal(lead.extra.orders[0].orderId, 'ORD-TEST0002');
  assert.match(lead.notes, new RegExp(`won: order ORD-TEST0002 on ${ORDER_SITE.replace(/\./g, '\\.')}`));
});

test('the name and the city match a lead that has no phone on it', () => {
  const order = normaliseOrder(siteOrder({ order: { phone: '', businessName: 'Nameless Mess', city: 'Bengaluru' } }));
  const { lead, matchedOn } = matchLead(LEADS, order);
  assert.equal(matchedOn, 'name+city');
  assert.equal(lead.name, 'Nameless Mess');
});

// ------------------------------------------------------------------ the alert

test('when Meta refuses with 131047 the refusal is recorded and the alert goes out by email', async (t) => {
  const fake = await fakeCloudApi(t, { ok: false, body: WINDOW_CLOSED_BODY });
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  const outboxDir = await mkdtemp(path.join(tmpdir(), 'radar-orders-outbox-'));

  const order = normaliseOrder(siteOrder());
  const alert = await alertOwner(order, {
    env: {
      WA_FAKE_FETCH_URL: fake.url,
      WA_TOKEN: 'test-token',
      WA_PHONE_NUMBER_ID: '1',
      RADAR_TO_WA: OWNER,
      RADAR_SMTP_URL: smtp.url(),
      RADAR_TO: 'owner@example.test',
      RADAR_FROM: 'radar@example.test',
    },
    outboxDir,
    smtpConnect: net.connect,
  });

  assert.equal(alert.whatsapp.sent, false);
  assert.equal(alert.whatsapp.errorCode, WINDOW_CLOSED_CODE);
  assert.equal(alert.whatsapp.windowClosed, true);
  assert.equal(alert.email.sent, true);
  assert.equal(alert.channel, 'email');
  assert.equal(alertLabel(alert), 'email (WhatsApp window closed)');

  const message = smtp.sessions[0].message;
  assert.ok(message.includes('New order ORD-TEST0001'));
  assert.ok(message.includes('131047'), 'the email says why WhatsApp did not carry it');
  assert.deepEqual(smtp.sessions[0].recipients, ['<owner@example.test>']);
});

test('with no channel configured at all the order is still recorded and the failure is stated', async (t) => {
  const store = fixtureStore();
  const outboxDir = await mkdtemp(path.join(tmpdir(), 'radar-orders-outbox-'));
  const result = await recordOrder(store, siteOrder(), {
    env: {},
    runsDir: await tmpRuns(),
    outboxDir,
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.alert.channel, 'none');
  assert.equal(result.alert.whatsapp.sent, false);
  assert.equal(result.alert.email.sent, false);
  assert.match(alertLabel(result.alert), /^not delivered: /);
  assert.equal((await store.getLead(result.leadId)).status, 'won', 'the register is written even when nobody could be told');
});

// ------------------------------------------------------------------ the pages

test('the Orders page lists the order and the CSV carries it', async (t) => {
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const { postOrder, auth } = await withServer(t, {
    store,
    env: { WA_FAKE_FETCH_URL: fake.url, WA_TOKEN: 'test-token', WA_PHONE_NUMBER_ID: '1' },
  });
  await postOrder(siteOrder());

  const page = await auth('/orders');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('ORD-TEST0001'));
  assert.ok(page.text.includes('Radar Loop Test Kitchen'));
  assert.ok(page.text.includes('Bengaluru'));
  assert.ok(page.text.includes('WhatsApp sent'));
  assert.ok(page.text.includes('href="/orders"'), 'the Orders tab is in the navigation');

  const csv = await auth('/orders.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.split('\n')[0].startsWith('id,date,receivedAt,buyer'));
  assert.ok(csv.text.includes('ORD-TEST0001'));
});

test('the Orders page and the CSV are owner-only', async (t) => {
  const { request } = await withServer(t);
  for (const p of ['/orders', '/orders.csv']) {
    const res = await request(p);
    assert.equal(res.status, 401, `${p} without a token`);
  }
});

test('the Orders page says so honestly when no order has arrived', async (t) => {
  const { auth } = await withServer(t);
  const page = await auth('/orders');
  assert.equal(page.status, 200);
  assert.match(page.text, /No order has reached the radar yet/);
});

test('the weekly report counts orders by city, by product and by buyer', () => {
  const orders = [
    {
      id: 'ORD-A', createdAt: '2026-09-09T05:00:00.000Z', receivedAt: '2026-09-09T05:00:00.000Z',
      businessName: 'Copper Chimney', city: 'Bengaluru', products: ['Peeled garlic'], orderDetails: 'Peeled garlic 20 kg',
      alert: { whatsapp: { sent: true } },
    },
    {
      id: 'ORD-B', createdAt: '2026-09-10T05:00:00.000Z', receivedAt: '2026-09-10T05:00:00.000Z',
      businessName: 'Hotel Sunrise', city: 'bengaluru', products: ['Peeled garlic', 'Broccoli'], orderDetails: 'x',
      alert: { whatsapp: { sent: false }, email: { sent: false } },
    },
    // Last week: must not be counted in 2026-W37.
    {
      id: 'ORD-C', createdAt: '2026-09-02T05:00:00.000Z', receivedAt: '2026-09-02T05:00:00.000Z',
      businessName: 'Old Buyer', city: 'Chennai', products: ['Broccoli'], orderDetails: 'y', alert: {},
    },
  ];
  const d = collectReport({ leads: [], runs: [], events: [], orders, week: '2026-W37', today: '2026-09-14' });
  assert.equal(d.orders.count, 2);
  assert.equal(d.orders.total, 3);
  assert.deepEqual(d.orders.byCity, [['Bengaluru', 2]]);
  assert.deepEqual(d.orders.byProduct, [['Peeled garlic', 2], ['Broccoli', 1]]);
  assert.deepEqual(d.orders.buyers, ['Copper Chimney', 'Hotel Sunrise']);
  assert.equal(d.orders.notDelivered, 1);
});

test('the CSV of orders escapes a comma in the lines', () => {
  const csv = ordersToCsv([
    { id: 'ORD-X', createdAt: '2026-09-14', receivedAt: '2026-09-14', businessName: 'A, B Traders', products: ['Garlic, peeled'], orderDetails: '', alert: {} },
  ]);
  assert.ok(csv.includes('"A, B Traders"'));
  assert.ok(csv.includes('"Garlic, peeled"'));
});

// ------------------------------------------------------------------ the tools

test('orders.list is a read any desk caller may make', async (t) => {
  const store = fixtureStore();
  await recordOrder(store, siteOrder(), { env: {}, runsDir: await tmpRuns(), outboxDir: await mkdtemp(path.join(tmpdir(), 'ob-')), notify: false });
  const call = await callTool('orders.list', { query: 'garlic' }, { store, actor: 'agent', env: {}, runsDir: await tmpRuns() });
  assert.equal(call.ok, true);
  assert.equal(call.output.matched, 1);
  assert.equal(call.output.orders[0].id, 'ORD-TEST0001');
  assert.equal(call.output.orders[0].buyer, 'Radar Loop Test Kitchen');
});

test('orders.record is refused for an agent and applied for the owner', async (t) => {
  const store = fixtureStore();
  const runsDir = await tmpRuns();
  const refused = await callTool(
    'orders.record',
    { orderDetails: '200 kg peeled garlic weekly' },
    { store, actor: 'agent', env: {}, runsDir }
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.match(refused.error, /owner-only/);
  assert.equal((await store.allOrders()).length, 0);

  const existing = LEADS.find((l) => l.name === 'Copper Chimney');
  const applied = await callTool(
    'orders.record',
    { orderDetails: '200 kg peeled garlic weekly', leadId: existing.id, notify: false },
    { store, actor: 'owner', env: {}, runsDir }
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.output.leadId, existing.id);
  assert.equal(applied.output.matchedOn, 'phone');
  assert.match(applied.output.orderId, /^OWN-\d{8}-[0-9A-F]{8}$/);
  assert.equal((await store.getLead(existing.id)).status, 'won');

  // The same reference twice changes nothing the second time.
  const again = await callTool(
    'orders.record',
    { orderId: applied.output.orderId, orderDetails: '200 kg peeled garlic weekly', notify: false },
    { store, actor: 'owner', env: {}, runsDir }
  );
  assert.equal(again.output.duplicate, true);
  assert.equal((await store.allOrders()).length, 1);
});

// ------------------------------------------------------------------ the O command

test('the O command grammar takes the rest of the line as the order', () => {
  assert.deepEqual(matchOrderCommand('O 200 kg peeled garlic weekly, Copper Chimney'), {
    orderDetails: '200 kg peeled garlic weekly, Copper Chimney',
  });
  assert.deepEqual(matchOrderCommand('o  40 kg broccoli '), { orderDetails: '40 kg broccoli' });
  assert.equal(matchOrderCommand('O'), null);
  assert.equal(matchOrderCommand('Ok thanks'), null);
  assert.equal(matchOrderCommand('L3 won'), null, 'a status command is not an order');
});

test('the last matched lead is the one the last status command touched', () => {
  assert.equal(lastMatchedLeadId([]), null);
  assert.equal(
    lastMatchedLeadId([
      { type: 'lead.status_changed', at: '2026-09-09T09:00:00.000Z', leadId: 'aaa' },
      { type: 'lead.status_changed', at: '2026-09-10T09:00:00.000Z', leadId: 'bbb' },
      { type: 'order.received', at: '2026-09-11T09:00:00.000Z', leadId: 'ccc' },
    ]),
    'bbb'
  );
});

test('O over WhatsApp records an order against the lead the owner last touched and replies with it', async (t) => {
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const wonLead = LEADS.find((l) => l.name === 'Anand Caterers');
  const { request, runsDir } = await withServer(t, {
    store,
    env: {
      WA_FAKE_FETCH_URL: fake.url,
      WA_TOKEN: 'test-token',
      WA_PHONE_NUMBER_ID: '1',
      WA_APP_SECRET: 'app-secret-for-the-test',
      WA_VERIFY_TOKEN: 'verify-token-for-the-test',
    },
  });

  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                { id: 'wamid.order-command-1', from: OWNER, timestamp: '1789000000', type: 'text', text: { body: 'O 200 kg peeled garlic weekly, Copper Chimney' } },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await request('/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(Buffer.from(body, 'utf8'), 'app-secret-for-the-test') },
    body,
  });
  assert.equal(res.status, 200);
  await whenWebhookIdle();

  const orders = await store.allOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderDetails, '200 kg peeled garlic weekly, Copper Chimney');
  assert.equal(orders[0].sourcePath, 'whatsapp');
  // The lead the owner's last status command touched: Anand Caterers.
  assert.equal(orders[0].leadId, wonLead.id);

  // One reply, and no second alert message about the same order.
  assert.equal(fake.calls.length, 1);
  const reply = JSON.parse(fake.calls[0].body);
  assert.equal(reply.to, OWNER);
  assert.match(reply.text.body, /^Order OWN-\d{8}-[0-9A-F]{8} recorded against Anand Caterers/);

  const files = (await readdir(runsDir)).filter((f) => f.startsWith('webhook_'));
  assert.equal(files.length, 1);
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.ok(bundle.receipts.some((r) => r.type === 'whatsapp.order' && r.orderId));
});

test('an alert the Cloud API accepted and Meta then failed falls back to email on the status callback', async (t) => {
  const store = fixtureStore();
  // The API says 200 and hands back a message id, exactly as it does in life.
  const fake = await fakeCloudApi(t);
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  const outboxDir = await mkdtemp(path.join(tmpdir(), 'radar-orders-outbox-'));
  const env = {
    WA_FAKE_FETCH_URL: fake.url,
    WA_TOKEN: 'test-token',
    WA_PHONE_NUMBER_ID: '1',
    RADAR_TO_WA: OWNER,
    RADAR_SMTP_URL: smtp.url(),
    RADAR_TO: 'owner@example.test',
    RADAR_FROM: 'radar@example.test',
  };

  const result = await recordOrder(store, siteOrder(), { env, runsDir: await tmpRuns(), outboxDir });
  assert.equal(result.alert.whatsapp.sent, true, 'the API accepted it');
  assert.equal(result.alert.channel, 'whatsapp');
  const messageId = result.alert.whatsapp.messageId;

  const resent = await alertFailedLater(
    store,
    { messageId, error: { code: WINDOW_CLOSED_CODE, title: 'Re-engagement message' } },
    { env, outboxDir, smtpConnect: net.connect }
  );
  assert.equal(resent.orderId, 'ORD-TEST0001');
  assert.equal(resent.channel, 'email');
  assert.equal(resent.emailSent, true);

  const stored = await store.getOrder('ORD-TEST0001');
  assert.equal(stored.alert.whatsapp.sent, false, 'a message Meta failed is not a message that was sent');
  assert.equal(stored.alert.whatsapp.failedLater, true);
  assert.equal(stored.alert.whatsapp.windowClosed, true);
  assert.equal(stored.alert.email.sent, true);
  assert.equal(alertLabel(stored.alert), 'email (WhatsApp failed: window closed)');
  assert.ok(smtp.sessions[0].message.includes('New order ORD-TEST0001'));

  const alerts = (await store.allEvents()).filter((e) => e.type === 'order.alert');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].channel, 'email');

  // A second callback for the same message does nothing: the owner has the email.
  assert.equal(await alertFailedLater(store, { messageId, error: null }, { env, outboxDir, smtpConnect: net.connect }), null);
  assert.equal(await alertFailedLater(store, { messageId: 'wamid.unknown' }, { env }), null, 'a failure that is not an order alert is not our business');
});

test('a failed delivery status on the webhook sends the email fallback', async (t) => {
  const store = fixtureStore();
  const fake = await fakeCloudApi(t);
  const outboxDir = await mkdtemp(path.join(tmpdir(), 'radar-orders-outbox-'));
  const { request, runsDir } = await withServer(t, {
    store,
    env: {
      WA_FAKE_FETCH_URL: fake.url,
      WA_TOKEN: 'test-token',
      WA_PHONE_NUMBER_ID: '1',
      WA_APP_SECRET: 'app-secret-for-the-test',
      RADAR_SMTP_URL: null,
      RADAR_TO: null,
    },
  });
  const result = await recordOrder(store, siteOrder(), { env: process.env, runsDir, outboxDir });
  const messageId = result.alert.whatsapp.messageId;

  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              statuses: [
                {
                  id: messageId,
                  status: 'failed',
                  timestamp: '1789000100',
                  recipient_id: OWNER,
                  errors: [{ code: WINDOW_CLOSED_CODE, title: 'Re-engagement message' }],
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await request('/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(Buffer.from(body, 'utf8'), 'app-secret-for-the-test') },
    body,
  });
  assert.equal(res.status, 200);
  await whenWebhookIdle();

  const stored = await store.getOrder('ORD-TEST0001');
  assert.equal(stored.alert.whatsapp.failedLater, true);
  // No SMTP is configured here, so the honest answer is that nobody was told.
  assert.equal(stored.alert.channel, 'none');
  assert.match(alertLabel(stored.alert), /^not delivered: /);

  const files = (await readdir(runsDir)).filter((f) => f.startsWith('webhook_'));
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.ok(bundle.receipts.some((r) => r.type === 'order.alert.resent' && r.orderId === 'ORD-TEST0001'));
});
