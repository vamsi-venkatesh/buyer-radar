// The WhatsApp Cloud API webhook. Nothing here touches the network: the only
// HTTP servers are the dashboard itself on an ephemeral port and a local
// recorder that stands in for graph.facebook.com through WA_FAKE_FETCH_URL.

import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/dashboard/server.mjs';
import {
  whenWebhookIdle,
  verifySignature,
  matchCommand,
  parseChanges,
  webhookSummary,
  openWindow,
  signBody,
} from '../src/webhook.mjs';
import { verifyBundle } from '../src/lib/receipts.mjs';
import { fixtureStore, LEADS } from './fixtures/store.mjs';

const TOKEN = 'test-owner-token-0123456789';
const VERIFY_TOKEN = 'verify-token-for-the-test';
const APP_SECRET = 'app-secret-for-the-test';
const OWNER = '919845000000';
const STRANGER = '919000000001';

const FIRST_LEAD = LEADS.find((l) => l.name === 'Copper Chimney');

/** A local recorder standing in for the Cloud API. Records, never forwards. */
async function fakeCloudApi(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.reply${calls.length}` }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, url: `http://127.0.0.1:${server.address().port}/messages` };
}

async function withServer(t, { env = {}, store = fixtureStore({ events: [] }) } = {}) {
  const digestsDir = await mkdtemp(path.join(tmpdir(), 'radar-digests-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-runs-'));
  await writeFile(
    path.join(digestsDir, '2026-09-10.txt'),
    `${CLIENT.digest.title} - 2026-09-10\n\nL1 Copper Chimney - restaurant\n`
  );
  await writeFile(
    path.join(digestsDir, '2026-09-10.prices.txt'),
    'Mandi price sheet - 2026-09-10\nPeeled garlic: Rs 14000/qtl\n'
  );
  await writeFile(
    path.join(digestsDir, '2026-09-10.index.json'),
    JSON.stringify({ L1: FIRST_LEAD.id })
  );

  const before = { ...process.env };
  Object.assign(process.env, {
    WA_VERIFY_TOKEN: VERIFY_TOKEN,
    WA_APP_SECRET: APP_SECRET,
    RADAR_TO_WA: OWNER,
    ...env,
  });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  });

  const server = createServer({ token: TOKEN, digestsDir, runsDir, storeFactory: async () => store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const request = (p, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  /** POST a raw body with a correct signature unless one is given. */
  const post = async (raw, { signature, omitSignature = false } = {}) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': buf.length };
    if (!omitSignature) headers['X-Hub-Signature-256'] = signature === undefined ? signBody(buf, APP_SECRET) : signature;
    const res = await request('/webhook', { method: 'POST', headers, body: buf });
    await whenWebhookIdle();
    return res;
  };

  return { request, post, store, digestsDir, runsDir, port };
}

function inboundBody({ id = 'wamid.AAA1', from = OWNER, text = 'hello', timestamp = '1789000000' } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '918000000000', phone_number_id: '1' },
              messages: [{ from, id, timestamp, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

function statusBody({ id = 'wamid.OUT1', status = 'delivered', errors, timestamp = '1789000100' } = {}) {
  const entry = { id, status, timestamp, recipient_id: OWNER };
  if (errors) entry.errors = errors;
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [entry] } }] }],
  });
}

async function events(store, type) {
  return (await store.allEvents()).filter((e) => e.type === type);
}

async function webhookBundle(runsDir) {
  const files = (await readdir(runsDir)).filter((f) => /^webhook_.*\.evidence\.json$/.test(f));
  if (!files.length) return null;
  return JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
}

// ------------------------------------------------------------------ GET verify

test('GET verification echoes the challenge when the token matches', async (t) => {
  const { request } = await withServer(t);
  const res = await request(
    `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`
  );
  assert.equal(res.status, 200);
  assert.equal(res.text, '1158201444');
  assert.match(res.headers['content-type'], /text\/plain/);
});

test('GET verification is 403 on a wrong token and on a wrong mode', async (t) => {
  const { request } = await withServer(t);
  const bad = await request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123');
  assert.equal(bad.status, 403);
  assert.ok(!bad.text.includes('123'));
  const wrongMode = await request(
    `/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`
  );
  assert.equal(wrongMode.status, 403);
});

test('GET verification is 503 when WA_VERIFY_TOKEN is unset', async (t) => {
  const { request } = await withServer(t, { env: { WA_VERIFY_TOKEN: undefined } });
  const res = await request('/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123');
  assert.equal(res.status, 503);
  assert.match(res.text, /WA_VERIFY_TOKEN is not set/);
});

test('the webhook needs no owner token, and the other routes still do', async (t) => {
  const { request } = await withServer(t);
  assert.equal((await request('/')).status, 401);
  assert.equal(
    (await request(`/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ok`)).status,
    200
  );
});

// ------------------------------------------------------------------ signature

test('a valid signature is accepted and an invalid one is 401 with a receipt', async (t) => {
  const { post, store, runsDir } = await withServer(t);
  const good = await post(inboundBody({ id: 'wamid.SIG1', from: STRANGER }));
  assert.equal(good.status, 200);

  const bad = await post(inboundBody({ id: 'wamid.SIG2', from: STRANGER }), {
    signature: `sha256=${'0'.repeat(64)}`,
  });
  assert.equal(bad.status, 401);
  const rejected = await events(store, 'whatsapp.rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /invalid X-Hub-Signature-256/);
  // The refused body was never treated as an event.
  assert.equal((await events(store, 'whatsapp.inbound')).filter((e) => e.messageId === 'wamid.SIG2').length, 0);
  const bundle = await webhookBundle(runsDir);
  assert.ok(bundle.receipts.some((r) => r.type === 'whatsapp.rejected'));
});

test('a missing signature is 401 and recorded as missing', async (t) => {
  const { post, store } = await withServer(t);
  const res = await post(inboundBody({ id: 'wamid.NOSIG' }), { omitSignature: true });
  assert.equal(res.status, 401);
  const rejected = await events(store, 'whatsapp.rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /missing X-Hub-Signature-256/);
});

test('a malformed signature header is refused, not parsed loosely', async (t) => {
  const { post } = await withServer(t);
  for (const sig of ['', 'sha256=', 'deadbeef', `sha1=${'0'.repeat(40)}`, `sha256=${'0'.repeat(63)}`]) {
    const res = await post(inboundBody({ id: 'wamid.MAL' }), { signature: sig });
    assert.equal(res.status, 401, `signature ${JSON.stringify(sig)}`);
  }
});

test('POST is 503 when WA_APP_SECRET is unset - an unsigned event is never accepted', async (t) => {
  const { post, store } = await withServer(t, { env: { WA_APP_SECRET: undefined } });
  const res = await post(inboundBody({ id: 'wamid.NOSECRET' }), { omitSignature: true });
  assert.equal(res.status, 503);
  assert.match(res.text, /WA_APP_SECRET is not set/);
  assert.equal((await events(store, 'whatsapp.inbound')).length, 0);
});

test('the HMAC is computed on the exact bytes, unicode and trailing newline included', async (t) => {
  const { post, store } = await withServer(t);
  const raw = Buffer.from(`${inboundBody({ id: 'wamid.UNI1', from: STRANGER, text: 'ಟೊಮೊಟೊ 🍅 – ₹40' })}\n`, 'utf8');
  assert.equal(raw[raw.length - 1], 0x0a);
  const res = await post(raw);
  assert.equal(res.status, 200);
  assert.equal((await events(store, 'whatsapp.inbound')).length, 1);

  // The same JSON re-serialised is different bytes, so the old signature must fail.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
  assert.notEqual(reserialised.length, raw.length);
  const stale = await post(reserialised, { signature: signBody(raw, APP_SECRET) });
  assert.equal(stale.status, 401);

  assert.equal(verifySignature(raw, signBody(raw, APP_SECRET), APP_SECRET), true);
  assert.equal(verifySignature(reserialised, signBody(raw, APP_SECRET), APP_SECRET), false);
  assert.equal(verifySignature(raw, signBody(raw, APP_SECRET), 'another-secret'), false);
  assert.equal(
    verifySignature(raw, `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`, APP_SECRET),
    true
  );
});

// ------------------------------------------------------------------ idempotency

test('a redelivered inbound message is acknowledged and recorded as a duplicate', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, store, runsDir } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  const body = inboundBody({ id: 'wamid.DUP1', from: OWNER, text: 'L1 contacted first pass' });

  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200);

  assert.equal((await events(store, 'whatsapp.inbound')).length, 1);
  const dupes = await events(store, 'whatsapp.duplicate');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].messageId, 'wamid.DUP1');
  // The command was applied once, so exactly one reply went out.
  assert.equal(fake.calls.length, 1);
  assert.equal((await events(store, 'lead.status_changed')).length, 1);

  const bundle = await webhookBundle(runsDir);
  assert.equal(bundle.receipts.filter((r) => r.type === 'whatsapp.inbound').length, 1);
  assert.equal(bundle.receipts.filter((r) => r.type === 'whatsapp.duplicate').length, 1);
  assert.equal(verifyBundle(bundle).ok, true, 'the appended bundle still verifies');
});

test('a redelivered status is recorded once per (id, status) pair', async (t) => {
  const { post, store } = await withServer(t);
  const body = statusBody({ id: 'wamid.OUT9', status: 'delivered' });
  await post(body);
  await post(body);
  await post(statusBody({ id: 'wamid.OUT9', status: 'read' }));

  const statuses = await events(store, 'whatsapp.status');
  assert.deepEqual(
    statuses.map((s) => s.key),
    ['wamid.OUT9:delivered', 'wamid.OUT9:read']
  );
  assert.equal((await events(store, 'whatsapp.duplicate')).length, 1);
});

test('a failed status records the error code and title', async (t) => {
  const { post, store, runsDir } = await withServer(t);
  await post(
    statusBody({
      id: 'wamid.FAIL1',
      status: 'failed',
      errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed.' } }],
    })
  );
  const [failed] = await events(store, 'whatsapp.status');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 131047);
  assert.equal(failed.error.title, 'Re-engagement message');

  const bundle = await webhookBundle(runsDir);
  const receipt = bundle.receipts.find((r) => r.type === 'whatsapp.status');
  assert.equal(receipt.error.code, 131047);
  assert.equal(verifyBundle(bundle).ok, true);

  const summary = webhookSummary(await store.allEvents());
  assert.match(summary.lastFailure.line, /131047/);
});

// ------------------------------------------------------------------ commands

test('an owner command applies the status through the register and replies once', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, store, runsDir } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  const res = await post(inboundBody({ id: 'wamid.CMD1', from: OWNER, text: 'L1 contacted test' }));
  assert.equal(res.status, 200);

  const lead = await store.getLead(FIRST_LEAD.id);
  assert.equal(lead.status, 'contacted');
  assert.match(lead.notes, /contacted: test/);

  assert.equal(fake.calls.length, 1);
  const sent = JSON.parse(fake.calls[0].body);
  assert.equal(sent.messaging_product, 'whatsapp');
  assert.equal(sent.to, OWNER);
  assert.match(sent.text.body, /Copper Chimney: new to contacted\. Receipt [0-9a-f]{12}\./);

  // The register's own receipt was written too, exactly as the CLI writes it.
  const statusBundles = (await readdir(runsDir)).filter((f) => f.startsWith('status_'));
  assert.equal(statusBundles.length, 1);
  const bundle = await webhookBundle(runsDir);
  const command = bundle.receipts.find((r) => r.type === 'whatsapp.command');
  assert.equal(command.to, 'contacted');
  assert.equal(command.leadId, FIRST_LEAD.id);
  assert.equal(verifyBundle(bundle).ok, true);
});

test('the command grammar is case-insensitive and the note is optional', () => {
  assert.deepEqual(matchCommand('L12 WON'), { ref: 'L12', status: 'won', note: null });
  assert.deepEqual(matchCommand('  l3   quoted   40 kg daily  '), { ref: 'L3', status: 'quoted', note: '40 kg daily' });
  assert.deepEqual(matchCommand('L1 new'), { ref: 'L1', status: 'new', note: null });
  assert.equal(matchCommand('L1 shipped'), null);
  assert.equal(matchCommand('what are the prices today'), null);
  assert.equal(matchCommand('L1'), null);
});

test('a command naming a lead that is not in the digest replies with the reason and changes nothing', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, store } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  await post(inboundBody({ id: 'wamid.CMD404', from: OWNER, text: 'L99 won' }));
  assert.equal((await events(store, 'lead.status_changed')).length, 0);
  assert.equal(fake.calls.length, 1);
  assert.match(JSON.parse(fake.calls[0].body).text.body, /not applied/);
});

test('other owner text is answered with the latest digest and price sheet', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  await post(inboundBody({ id: 'wamid.TXT1', from: OWNER, text: 'send the full list' }));
  assert.equal(fake.calls.length, 1);
  const body = JSON.parse(fake.calls[0].body).text.body;
  assert.match(body, new RegExp(`${CLIENT.digest.title} - 2026-09-10`));
  assert.match(body, /Peeled garlic: Rs 14000\/qtl/);
});

test('a message from any other number is recorded and never answered', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, store } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  await post(inboundBody({ id: 'wamid.STR1', from: STRANGER, text: 'L1 won - please send rates' }));

  const [inbound] = await events(store, 'whatsapp.inbound');
  assert.equal(inbound.from, STRANGER);
  assert.equal(inbound.owner, false);
  assert.equal(inbound.text, null, 'a buyer\'s words are not stored');
  assert.equal(inbound.textChars, 'L1 won - please send rates'.length);
  assert.equal(fake.calls.length, 0, 'no reply was sent');
  assert.equal((await events(store, 'lead.status_changed')).length, 0, 'a stranger cannot move a lead');
});

test('the owner is matched on digits, so +91 98450 00000 is the same number', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, store } = await withServer(t, {
    env: { WA_FAKE_FETCH_URL: fake.url, RADAR_TO_WA: `+91 98450 00000` },
  });
  await post(inboundBody({ id: 'wamid.FMT1', from: OWNER, text: 'anything' }));
  const [inbound] = await events(store, 'whatsapp.inbound');
  assert.equal(inbound.owner, true);
  assert.equal(fake.calls.length, 1);
});

test('with no send configuration the reply is reported as not sent, not silently dropped', async (t) => {
  const { post, store, runsDir } = await withServer(t);
  await post(inboundBody({ id: 'wamid.NOSEND', from: OWNER, text: 'full list please' }));
  const bundle = await webhookBundle(runsDir);
  const reply = bundle.receipts.find((r) => r.type === 'whatsapp.reply');
  assert.equal(reply.sent, false);
  assert.match(reply.reason, /WA_PHONE_NUMBER_ID, WA_TOKEN unset/);
  assert.equal((await events(store, 'whatsapp.inbound')).length, 1);
});

// ------------------------------------------------------------------ parsing and views

test('only the messages field is read, and an unknown field is ignored', () => {
  const parsed = parseChanges({
    entry: [
      { changes: [{ field: 'account_review_update', value: { messages: [{ id: 'x' }] } }] },
      { changes: [{ field: 'messages', value: { messages: [{ id: 'm1' }], statuses: [{ id: 's1', status: 'sent' }] } }] },
    ],
  });
  assert.deepEqual(parsed.messages.map((m) => m.id), ['m1']);
  assert.deepEqual(parsed.statuses.map((s) => s.id), ['s1']);
  assert.deepEqual(parseChanges({}), { messages: [], statuses: [] });
});

test('a body that is not JSON is refused after the signature check and recorded', async (t) => {
  const { post, runsDir } = await withServer(t);
  const res = await post(Buffer.from('not json at all', 'utf8'));
  assert.equal(res.status, 200, 'a signed but unreadable body is still acknowledged');
  const bundle = await webhookBundle(runsDir);
  assert.ok(bundle.receipts.some((r) => r.type === 'whatsapp.rejected' && /not JSON/.test(r.reason)));
});

test('the window marker opens for 24 hours and then closes', () => {
  const evts = [{ type: 'whatsapp.window', at: '2026-09-11T08:00:00.000Z', lastInboundAt: '2026-09-11T08:00:00.000Z', from: OWNER }];
  const open = openWindow(evts, new Date('2026-09-11T20:00:00.000Z'));
  assert.equal(open.until, '2026-09-12T08:00:00.000Z');
  assert.equal(openWindow(evts, new Date('2026-09-12T08:00:01.000Z')), null);
  assert.equal(openWindow([], new Date()), null);
});

test('the runs page shows a webhook section and Today shows an open window', async (t) => {
  const fake = await fakeCloudApi(t);
  const { post, request } = await withServer(t, { env: { WA_FAKE_FETCH_URL: fake.url } });
  const now = Math.floor(Date.now() / 1000);
  await post(inboundBody({ id: 'wamid.VIEW1', from: OWNER, text: 'full list', timestamp: String(now) }));
  await post(statusBody({ id: 'wamid.VIEW2', status: 'delivered', timestamp: String(now) }));

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const runs = await request('/runs', { headers: auth });
  assert.equal(runs.status, 200);
  assert.match(runs.text, /<h2>Webhook<\/h2>/);
  assert.match(runs.text, /webhook_&lt;date&gt;\.evidence\.json/);

  const today = await request('/', { headers: auth });
  assert.match(today.text, /WhatsApp window open until/);
});
