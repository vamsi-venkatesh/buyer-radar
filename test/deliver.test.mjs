import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildEmailMessage,
  buildWhatsAppPayload,
  trimForWhatsApp,
  bodyText,
  rfc5322Date,
  deliverEmail,
  deliverWhatsApp,
  parseChannels,
  WHATSAPP_MAX_CHARS,
} from '../src/deliver.mjs';
import { sendMail, parseSmtpUrl, prepareData, SmtpError } from '../src/lib/smtp.mjs';
import { startFakeSmtp } from './fixtures/fake-smtp.mjs';

const DIGEST = `${CLIENT.digest.title} - 2026-09-11 - Bengaluru\n\nL1 Copper Chimney - restaurant`;
const SHEET = 'Mandi price sheet - 2026-09-11\nPeeled garlic: Rs 14000/qtl';
const tmp = () => mkdtemp(path.join(tmpdir(), 'radar-outbox-'));

// ------------------------------------------------------------------ message

test('the email is a well-formed RFC 5322 message', () => {
  const msg = buildEmailMessage({
    date: '2026-09-11',
    digestText: DIGEST,
    priceSheet: SHEET,
    from: 'radar@example.test',
    to: 'owner@example.test',
    now: new Date('2026-09-11T01:30:00Z'),
    messageId: 'fixed@buyer-radar',
  });
  const [headers, ...rest] = msg.split('\n\n');
  const lines = headers.split('\n');
  assert.equal(lines[0], 'From: radar@example.test');
  assert.equal(lines[1], 'To: owner@example.test');
  assert.equal(lines[2], `Subject: ${CLIENT.digest.title} - 2026-09-11`);
  assert.equal(lines[3], 'Date: Fri, 11 Sep 2026 01:30:00 +0000');
  assert.equal(lines[4], 'Message-ID: <fixed@buyer-radar>');
  assert.ok(lines.includes('MIME-Version: 1.0'));
  assert.ok(lines.includes('Content-Type: text/plain; charset=utf-8'));
  // Exactly one blank line separates headers from the body.
  assert.equal(rest.join('\n\n').trim(), bodyText(DIGEST, SHEET));
});

test('a newline injected into a header value cannot forge a header', () => {
  const msg = buildEmailMessage({
    from: 'a@b.test',
    to: 'victim@example.test\nBcc: everyone@example.test',
    date: '2026-09-11\nX-Evil: yes',
    digestText: 'x',
  });
  const headers = msg.split('\n\n')[0].split('\n');
  assert.ok(!headers.some((h) => h.startsWith('Bcc:')), headers.join('|'));
  assert.ok(!headers.some((h) => h.startsWith('X-Evil:')));
  assert.equal(headers.filter((h) => h.startsWith('To:')).length, 1);
});

test('rfc5322Date is always UTC so it does not depend on the host time zone', () => {
  assert.equal(rfc5322Date(new Date('2026-01-04T23:05:09Z')), 'Sun, 04 Jan 2026 23:05:09 +0000');
});

// ------------------------------------------------------------------ smtp

test('parseSmtpUrl accepts smtps and refuses anything else, without leaking the password', () => {
  assert.deepEqual(parseSmtpUrl('smtps://u%40x.test:p%40ss@mail.example:465'), {
    host: 'mail.example',
    port: 465,
    user: 'u@x.test',
    pass: 'p@ss',
  });
  assert.equal(parseSmtpUrl('smtps://mail.example').port, 465);
  assert.throws(() => parseSmtpUrl('smtp://mail.example:25'), /must start with smtps/);
  try {
    parseSmtpUrl('not a url');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!/hunter2/.test(err.message));
  }
});

test('prepareData uses CRLF and dot-stuffs a leading dot', () => {
  assert.equal(prepareData('a\nb'), 'a\r\nb');
  assert.equal(prepareData('.leading\nnormal\n.'), '..leading\r\nnormal\r\n..');
  assert.equal(prepareData('a\r\nb'), 'a\r\nb', 'already-CRLF input is not doubled');
});

test('the smtp client completes the dialogue against a local fake server', async (t) => {
  const fake = await startFakeSmtp();
  t.after(() => fake.close());
  const message = buildEmailMessage({
    date: '2026-09-11',
    digestText: '.a line starting with a dot',
    priceSheet: SHEET,
    from: 'radar@example.test',
    to: 'owner@example.test',
    messageId: 'fixed@buyer-radar',
  });
  const result = await sendMail({
    url: fake.url('owner@example.test', 'secret'),
    from: 'radar@example.test',
    to: 'owner@example.test',
    message,
    connect: net.connect,
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(
    result.transcript.map((t2) => t2.stage),
    ['greeting', 'ehlo', 'auth', 'auth-user', 'auth-pass', 'mail-from', 'rcpt-to', 'data', 'data-body', 'quit']
  );
  const s = fake.sessions[0];
  assert.equal(s.authUser, 'owner@example.test');
  assert.equal(s.authPass, 'secret');
  assert.deepEqual(s.recipients, ['<owner@example.test>']);
  assert.ok(s.commands.includes('MAIL FROM:<radar@example.test>'));
  assert.ok(s.commands.includes('DATA'));
  assert.ok(s.commands.includes('QUIT'));
  // The dot-stuffing round-trips: the server sees the original line back.
  assert.match(s.message, /\n\.a line starting with a dot\n/);
  assert.match(s.message, new RegExp(`^Subject: ${CLIENT.digest.title} - 2026-09-11$`, 'm'));
});

test('a multi-line EHLO greeting is read as one reply', async (t) => {
  const fake = await startFakeSmtp({
    ehlo: '250-fake.local\r\n250-PIPELINING\r\n250-SIZE 1000\r\n250-8BITMIME\r\n250 AUTH LOGIN',
  });
  t.after(() => fake.close());
  const result = await sendMail({
    url: fake.url(),
    from: 'a@b.test',
    to: ['x@y.test', 'z@y.test'],
    message: 'Subject: t\n\nbody',
    connect: net.connect,
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(fake.sessions[0].recipients, ['<x@y.test>', '<z@y.test>']);
});

test('a refusing server raises an SmtpError naming the stage, and nothing is silently dropped', async (t) => {
  const fake = await startFakeSmtp({ rcptTo: '550 5.1.1 No such user' });
  t.after(() => fake.close());
  await assert.rejects(
    sendMail({ url: fake.url(), from: 'a@b.test', to: 'nobody@y.test', message: 'x', connect: net.connect }),
    (err) => {
      assert.ok(err instanceof SmtpError);
      assert.equal(err.stage, 'rcpt-to');
      assert.equal(err.code, 550);
      return true;
    }
  );
});

test('a server that refuses the body after DATA is reported as a failure', async (t) => {
  const fake = await startFakeSmtp({ dataAccepted: '552 5.3.4 Message too big' });
  t.after(() => fake.close());
  await assert.rejects(
    sendMail({ url: fake.url(), from: 'a@b.test', to: 'x@y.test', message: 'x', connect: net.connect }),
    /refused the message/
  );
});

// ------------------------------------------------------------------ email hook

test('with no RADAR_SMTP_URL the email is written to the outbox and reported as not sent', async () => {
  const outboxDir = await tmp();
  const result = await deliverEmail({
    date: '2026-09-11',
    digestText: DIGEST,
    priceSheet: SHEET,
    env: {},
    outboxDir,
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not sent: RADAR_SMTP_URL unset');
  assert.deepEqual(await readdir(outboxDir), ['2026-09-11.eml']);
  const written = await readFile(path.join(outboxDir, '2026-09-11.eml'), 'utf8');
  assert.match(written, new RegExp(`^Subject: ${CLIENT.digest.title} - 2026-09-11$`, 'm'));
  assert.match(written, /Copper Chimney/);
});

test('a configured RADAR_SMTP_URL with no RADAR_TO is still not sent', async () => {
  const outboxDir = await tmp();
  const result = await deliverEmail({
    date: '2026-09-11',
    digestText: DIGEST,
    env: { RADAR_SMTP_URL: 'smtps://u:p@mail.example:465' },
    outboxDir,
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not sent: RADAR_TO unset');
});

test('with both set, deliverEmail sends through the client and reports what happened', async (t) => {
  const fake = await startFakeSmtp();
  t.after(() => fake.close());
  const outboxDir = await tmp();
  const result = await deliverEmail({
    date: '2026-09-11',
    digestText: DIGEST,
    priceSheet: SHEET,
    env: {
      RADAR_SMTP_URL: fake.url('owner@example.test', 'secret'),
      RADAR_TO: 'owner@example.test',
      RADAR_FROM: 'radar@example.test',
    },
    outboxDir,
    connect: net.connect,
  });
  assert.equal(result.sent, true);
  assert.equal(result.to, 'owner@example.test');
  assert.equal(result.host, '127.0.0.1');
  assert.deepEqual(await readdir(outboxDir), [], 'a sent message is not also left in the outbox');
  assert.ok(!JSON.stringify(result).includes('secret'), 'the password is not in the result');
});

test('a send that fails leaves the message in the outbox and says why', async (t) => {
  const fake = await startFakeSmtp({ mailFrom: '451 4.3.0 Try again later' });
  t.after(() => fake.close());
  const outboxDir = await tmp();
  const result = await deliverEmail({
    date: '2026-09-11',
    digestText: DIGEST,
    env: { RADAR_SMTP_URL: fake.url(), RADAR_TO: 'owner@example.test' },
    outboxDir,
    connect: net.connect,
  });
  assert.equal(result.sent, false);
  assert.match(result.reason, /^not sent: SmtpError: mail-from failed/);
  assert.deepEqual(await readdir(outboxDir), ['2026-09-11.eml']);
});

// ------------------------------------------------------------------ whatsapp

test('the WhatsApp payload is a Cloud API text message', () => {
  assert.deepEqual(buildWhatsAppPayload({ to: '919845000001', text: 'hello' }), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '919845000001',
    type: 'text',
    text: { preview_url: false, body: 'hello' },
  });
});

test('a body over the Cloud API limit is trimmed, and says it was trimmed', () => {
  const long = trimForWhatsApp('x'.repeat(WHATSAPP_MAX_CHARS + 500));
  assert.equal(long.trimmed, true);
  assert.equal(long.text.length, WHATSAPP_MAX_CHARS);
  assert.match(long.text, /\[trimmed - open the dashboard for the rest\]$/);
  assert.equal(trimForWhatsApp('short').trimmed, false);
});

test('with no WhatsApp credentials the request is written to the outbox and not sent', async () => {
  const outboxDir = await tmp();
  const result = await deliverWhatsApp({
    date: '2026-09-11',
    digestText: DIGEST,
    priceSheet: SHEET,
    env: {},
    outboxDir,
    fetchImpl: () => assert.fail('the API must not be called when it is not configured'),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not sent: WA_PHONE_NUMBER_ID, WA_TOKEN, RADAR_TO_WA unset');
  const written = JSON.parse(await readFile(path.join(outboxDir, '2026-09-11.whatsapp.json'), 'utf8'));
  assert.equal(written.method, 'POST');
  assert.match(written.url, /^https:\/\/graph\.facebook\.com\/v20\.0\//);
  assert.equal(written.body.type, 'text');
  assert.match(written.body.text.body, /Copper Chimney/);
});

test('one missing WhatsApp variable is enough to stop the send, and it is named', async () => {
  const outboxDir = await tmp();
  const result = await deliverWhatsApp({
    env: { WA_PHONE_NUMBER_ID: '123', WA_TOKEN: 'tok', RADAR_TO_WA: '' },
    outboxDir,
    fetchImpl: () => assert.fail('must not be called'),
  });
  assert.equal(result.reason, 'not sent: RADAR_TO_WA unset');
});

test('a configured WhatsApp send posts the expected request (stub fetch, never the real API)', async () => {
  const outboxDir = await tmp();
  const calls = [];
  const result = await deliverWhatsApp({
    date: '2026-09-11',
    digestText: DIGEST,
    env: { WA_PHONE_NUMBER_ID: '15550001111', WA_TOKEN: 'tok-abc', RADAR_TO_WA: '919845000001' },
    outboxDir,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }) };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, 'wamid.TEST');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v20.0/15550001111/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-abc');
  assert.equal(JSON.parse(calls[0].init.body).to, '919845000001');
  assert.deepEqual(await readdir(outboxDir), []);
});

test('an API error is reported as not sent and the message is kept', async () => {
  const outboxDir = await tmp();
  const result = await deliverWhatsApp({
    date: '2026-09-11',
    digestText: DIGEST,
    env: { WA_PHONE_NUMBER_ID: '1', WA_TOKEN: 't', RADAR_TO_WA: '9' },
    outboxDir,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad token"}}' }),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not sent: WhatsApp API returned HTTP 401');
  assert.deepEqual(await readdir(outboxDir), ['2026-09-11.whatsapp.json']);
});

test('parseChannels validates and de-duplicates', () => {
  assert.deepEqual(parseChannels('email,whatsapp'), ['email', 'whatsapp']);
  assert.deepEqual(parseChannels(' EMAIL , email '), ['email']);
  assert.deepEqual(parseChannels(''), []);
  assert.throws(() => parseChannels('sms'), /unknown delivery channel: sms/);
});
