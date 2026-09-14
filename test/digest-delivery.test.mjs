// A 200 from the WhatsApp Cloud API is not a delivery.
//
// The API accepts the morning digest, hands back a message id and the run ends.
// Minutes later Meta fails the message on the webhook - 131047, the closed
// 24-hour window, most of the time - and until now nothing downstream knew.
// These tests hold the whole late path: the id is written down, the failure
// rewrites the record, the approved template is tried once, a template that
// fails too leaves the email as the delivery of record, and a redelivered
// status callback changes nothing.
//
// Nothing here touches the network. Every Cloud API call goes to a stub that
// answers exactly what the test says Meta answered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deliverWhatsApp } from '../src/deliver.mjs';
import {
  recordDigestMessages,
  digestFailedLater,
  digestDeliveries,
  deliveryLabel,
  EVENT_DIGEST_MESSAGE,
  EVENT_DIGEST_RESENT,
} from '../src/digest-delivery.mjs';
import { runsPage } from '../src/dashboard/pages.mjs';
import { fixtureStore } from './fixtures/store.mjs';

const DATE = '2026-09-14';
const DIGEST = 'Buyer Radar - 2026-09-14\n\nL1 Copper Chimney - restaurant\n  +91 98450 00001\n';
const PRICES = 'Mandi price sheet - 2026-09-14\nPeeled garlic: Rs 14000/qtl\n';

const ENV = {
  WA_PHONE_NUMBER_ID: '1',
  WA_TOKEN: 'test-token',
  RADAR_TO_WA: '919845000000',
  WA_TEMPLATE: 'buyer_radar_digest',
  WA_TEMPLATE_LANG: 'en',
};

/** A stub Cloud API. Each queued answer is used for one POST, in order. */
function stubFetch(answers = []) {
  const queue = [...answers];
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const a = queue.shift() || { ok: true, status: 200, id: `wamid.auto${calls.length}` };
    const text = a.body !== undefined
      ? a.body
      : a.ok
        ? JSON.stringify({ messages: [{ id: a.id }] })
        : JSON.stringify({ error: { code: a.code ?? 131047, message: a.message ?? 'refused' } });
    return { ok: a.ok, status: a.status ?? (a.ok ? 200 : 400), text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

async function digestsDirWith(date = DATE) {
  const dir = await mkdtemp(path.join(tmpdir(), 'radar-digest-delivery-'));
  await writeFile(path.join(dir, `${date}.txt`), DIGEST);
  await writeFile(path.join(dir, `${date}.prices.txt`), PRICES);
  return dir;
}

/** The state after a morning where the text was accepted and the email went out. */
async function morningWithAcceptedText(t, { emailSent = true } = {}) {
  const store = fixtureStore({ events: [] });
  const fetchImpl = stubFetch([{ ok: true, status: 200, id: 'wamid.text1' }]);
  const whatsapp = await deliverWhatsApp({
    date: DATE,
    digestText: DIGEST,
    priceSheet: PRICES,
    env: ENV,
    fetchImpl,
  });
  await store.appendEvents([
    { type: 'digest.delivered', at: `${DATE}T01:30:00.000Z`, key: null, channel: 'email', date: DATE, cities: ['Bengaluru'] },
  ]);
  await recordDigestMessages(store, { date: DATE, runId: `delivery_${DATE}`, cities: ['Bengaluru'], whatsapp, emailSent });
  return { store, whatsapp, fetchImpl };
}

test('an accepted digest text is written down under the id Meta gave it', async (t) => {
  const { store, whatsapp } = await morningWithAcceptedText(t);

  assert.equal(whatsapp.sent, true);
  assert.equal(whatsapp.via, 'text');
  assert.equal(whatsapp.messageId, 'wamid.text1');
  assert.deepEqual(whatsapp.messageIds, [{ kind: 'text', messageId: 'wamid.text1' }]);
  assert.equal(whatsapp.templateAttempted, false, 'the text went, so no template was tried');

  const record = await store.getEvent(EVENT_DIGEST_MESSAGE, 'wamid.text1');
  assert.ok(record, 'the webhook has something to look the id up against');
  assert.equal(record.kind, 'text');
  assert.equal(record.date, DATE);
  assert.equal(record.sent, true);
  assert.equal(record.failedLater, false);
  assert.equal(record.templateAttempted, false);
  assert.equal(record.emailSent, true);

  // As far as anything knows so far, both channels carried the morning.
  const rows = digestDeliveries(await store.allEvents());
  assert.equal(deliveryLabel(rows.find((r) => r.date === DATE)), 'email only');
});

test('a digest text Meta fails after accepting it is resent once as the approved template', async (t) => {
  const { store } = await morningWithAcceptedText(t);
  const digestsDir = await digestsDirWith();
  const fetchImpl = stubFetch([{ ok: true, status: 200, id: 'wamid.template1' }]);

  const out = await digestFailedLater(
    store,
    { messageId: 'wamid.text1', error: { code: 131047, title: 'Re-engagement message' } },
    { env: ENV, fetchImpl, digestsDir }
  );

  assert.equal(out.resent, true);
  assert.equal(out.resentMessageId, 'wamid.template1');
  assert.equal(out.errorCode, 131047);
  assert.equal(out.state, 'template sent');

  // One attempt, and it was the approved template for the right day.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.type, 'template');
  assert.equal(fetchImpl.calls[0].body.template.name, 'buyer_radar_digest');
  const params = fetchImpl.calls[0].body.template.components[0].parameters.map((p) => p.text);
  assert.match(params[0], /September/, 'the template carries the day the failed message was about');

  // The record is rewritten: a message Meta failed is not a message that was sent.
  const record = await store.getEvent(EVENT_DIGEST_MESSAGE, 'wamid.text1');
  assert.equal(record.sent, false);
  assert.equal(record.failedLater, true);
  assert.equal(record.errorCode, 131047);
  assert.equal(record.windowClosed, true);
  assert.equal(record.resentAs, 'wamid.template1');

  // The template is a message like any other, so a failure of ITS own is found.
  const second = await store.getEvent(EVENT_DIGEST_MESSAGE, 'wamid.template1');
  assert.equal(second.kind, 'template');
  assert.equal(second.templateAttempted, true, 'one attempt only - this one stops a third message');
  assert.equal(second.resentFor, 'wamid.text1');

  const resent = (await store.allEvents()).filter((e) => e.type === EVENT_DIGEST_RESENT);
  assert.equal(resent.length, 1);
  assert.equal(resent[0].messageId, 'wamid.template1');
  assert.equal(resent[0].via, 'template');
});

test('when the template fails too the email is the delivery of record and the page says so', async (t) => {
  const { store } = await morningWithAcceptedText(t);
  const digestsDir = await digestsDirWith();
  const fetchImpl = stubFetch([{ ok: false, status: 400, code: 131049, message: 'frequency cap' }]);

  const out = await digestFailedLater(
    store,
    { messageId: 'wamid.text1', error: { code: 131047 } },
    { env: ENV, fetchImpl, digestsDir }
  );

  assert.equal(out.resent, false);
  assert.equal(out.templateFailed, true);
  assert.equal(out.templateErrorCode, 131049);
  assert.equal(out.emailSent, true);
  assert.equal(out.state, 'email only', 'the email already went out with the same digest');

  const record = await store.getEvent(EVENT_DIGEST_MESSAGE, 'wamid.text1');
  assert.equal(record.failedLater, true);
  assert.equal(record.templateFailed, true);
  assert.equal(record.templateErrorCode, 131049);
  assert.equal(record.deliveredBy, 'email');

  const rows = digestDeliveries(await store.allEvents());
  const row = rows.find((r) => r.date === DATE);
  assert.equal(deliveryLabel(row), 'email only (WhatsApp failed: 131047)');

  // The owner's own page, not only the record behind it.
  const html = runsPage({ runs: [], webhook: null, deliveries: rows });
  assert.match(html, /Digest delivery/);
  assert.match(html, /email only \(WhatsApp failed: 131047\)/);
  assert.doesNotMatch(html, /email and WhatsApp/);
});

test('nothing was delivered at all is said as that, not as email', async (t) => {
  const { store } = await morningWithAcceptedText(t, { emailSent: false });
  const digestsDir = await digestsDirWith();
  const fetchImpl = stubFetch([{ ok: false, status: 400, code: 131049 }]);

  const out = await digestFailedLater(
    store,
    { messageId: 'wamid.text1', error: { code: 131047 } },
    { env: ENV, fetchImpl, digestsDir }
  );
  assert.equal(out.state, 'not delivered');
  assert.equal(out.emailSent, false);
});

test('a redelivered status callback changes nothing and sends no second message', async (t) => {
  const { store } = await morningWithAcceptedText(t);
  const digestsDir = await digestsDirWith();
  const fetchImpl = stubFetch([{ ok: true, status: 200, id: 'wamid.template1' }]);
  const ctx = { env: ENV, fetchImpl, digestsDir };

  const first = await digestFailedLater(store, { messageId: 'wamid.text1', error: { code: 131047 } }, ctx);
  assert.equal(first.resent, true);

  // Meta retries a status it thinks was not acknowledged.
  const again = await digestFailedLater(store, { messageId: 'wamid.text1', error: { code: 131047 } }, ctx);
  assert.equal(again, null, 'the record has already been rewritten');
  const third = await digestFailedLater(store, { messageId: 'wamid.text1', error: null }, ctx);
  assert.equal(third, null);

  assert.equal(fetchImpl.calls.length, 1, 'one template attempt, however many callbacks arrive');
  assert.equal((await store.allEvents()).filter((e) => e.type === EVENT_DIGEST_RESENT).length, 1);
  assert.equal(
    (await store.allEvents()).filter((e) => e.type === EVENT_DIGEST_MESSAGE).length,
    2,
    'the text record and the one template record, and nothing more'
  );
});

test('a failed message id that is not a digest of ours is not our business', async (t) => {
  const { store } = await morningWithAcceptedText(t);
  const fetchImpl = stubFetch();
  const out = await digestFailedLater(
    store,
    { messageId: 'wamid.someone-elses', error: { code: 131047 } },
    { env: ENV, fetchImpl, digestsDir: await digestsDirWith() }
  );
  assert.equal(out, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a morning whose text was refused in the POST does not get a second template attempt later', async (t) => {
  const store = fixtureStore({ events: [] });
  // The text is refused outright and the template carries the morning instead.
  const morning = stubFetch([
    { ok: false, status: 400, code: 131047 },
    { ok: true, status: 200, id: 'wamid.template0' },
  ]);
  const whatsapp = await deliverWhatsApp({
    date: DATE,
    digestText: DIGEST,
    priceSheet: PRICES,
    env: ENV,
    fetchImpl: morning,
  });
  assert.equal(whatsapp.via, 'template');
  assert.equal(whatsapp.templateAttempted, true);
  assert.deepEqual(whatsapp.messageIds, [{ kind: 'template', messageId: 'wamid.template0' }]);

  await recordDigestMessages(store, { date: DATE, cities: ['Bengaluru'], whatsapp, emailSent: true });

  // Meta then fails the template as well. There is no third message to send.
  const later = stubFetch();
  const out = await digestFailedLater(
    store,
    { messageId: 'wamid.template0', error: { code: 131049 } },
    { env: ENV, fetchImpl: later, digestsDir: await digestsDirWith() }
  );
  assert.equal(out.resent, false);
  assert.equal(out.state, 'email only');
  assert.equal(later.calls.length, 0, 'the template was already the fallback; it is not tried twice');

  const rows = digestDeliveries(await store.allEvents());
  assert.equal(deliveryLabel(rows.find((r) => r.date === DATE)), 'not delivered (WhatsApp failed: 131049)');
});
