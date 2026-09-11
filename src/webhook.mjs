// Meta WhatsApp Cloud API webhook.
//
// Served by the dashboard on ${RADAR_BASE_PATH}/webhook. It is the one route
// that is exempt from the owner token, because Meta cannot present one; what
// stands in its place is the app-secret signature on every POST body. An
// unsigned event is never accepted: with WA_APP_SECRET unset the route answers
// 503 rather than trusting the caller.
//
// What it does with an event:
//   - an inbound message from the owner's own number (RADAR_TO_WA) is a command
//     or a request for the digest, and gets one reply;
//   - an inbound message from any other number is recorded and never answered.
//     The radar starts no conversation with a buyer, so it finishes none either;
//   - a delivery status (sent/delivered/read/failed) is recorded, nothing more.
//
// Every batch appends receipts to runs/webhook_<date>.evidence.json, sealed with
// the same hash recipe as a run, so what arrived can be verified later with
// tools/verify.mjs. Message ids and (id, status) pairs are recorded once: Meta
// retries a delivery it thinks failed, and a retry must not re-apply a command.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReceiptChain } from './lib/receipts.mjs';
import { RUNS_DIR, DIGESTS_DIR } from './lib/paths.mjs';
import { todayIso, STATUSES } from './lib/normalise.mjs';
import { latestDigest } from './lib/digest-files.mjs';
import { setLeadStatus } from './register.mjs';
import { bodyText, sendWhatsAppText } from './deliver.mjs';

/** Meta's documented maximum payload is far below this; anything larger is refused. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** How long the customer-service window stays open after an inbound message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const EVENT_INBOUND = 'whatsapp.inbound';
export const EVENT_STATUS = 'whatsapp.status';
export const EVENT_DUPLICATE = 'whatsapp.duplicate';
export const EVENT_REJECTED = 'whatsapp.rejected';
export const EVENT_WINDOW = 'whatsapp.window';
export const EVENT_KINDS = [
  EVENT_INBOUND, EVENT_STATUS, EVENT_DUPLICATE, EVENT_REJECTED, EVENT_WINDOW,
  'whatsapp.command', 'whatsapp.reply',
];

// R<n> is a posted requirement, L<n> a buyer, G<n> a registration route - the
// three sections of the digest, each numbered in its own series.
const COMMAND_RE = /^([LRG])(\d+)\s+(won|lost|contacted|quoted|ignored|new)(?:\s+(.*))?$/i;

// ------------------------------------------------------------------ helpers

function plain(res, status, text, headers = {}) {
  const payload = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    ...headers,
  });
  res.end(payload);
}

/** Constant-time string compare that does not leak the length through an early return. */
export function safeEqualString(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  if (A.length !== B.length || A.length === 0) return false;
  return timingSafeEqual(A, B);
}

/** Digits only, so +91 98450 00001 and 919845000001 are the same number. */
export function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

export function sameNumber(a, b) {
  const A = digitsOnly(a);
  const B = digitsOnly(b);
  return A.length > 0 && A === B;
}

/**
 * X-Hub-Signature-256 over the EXACT bytes of the body. The signature is
 * computed on the raw buffer, never on a re-serialised object: JSON.parse
 * followed by JSON.stringify changes the bytes and would break every unicode
 * or trailing-newline body.
 */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  const m = String(header ?? '').match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!m) return false;
  const expected = createHmac('sha256', String(appSecret)).update(rawBody).digest('hex');
  return safeEqualString(expected, m[1].toLowerCase());
}

export function signBody(rawBody, appSecret) {
  return `sha256=${createHmac('sha256', String(appSecret)).update(rawBody).digest('hex')}`;
}

function readRawBody(req, limit = MAX_WEBHOOK_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.tooLarge = true;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Meta's envelope: entry[].changes[].value, messages field only. */
export function parseChanges(body) {
  const messages = [];
  const statuses = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      for (const m of Array.isArray(value.messages) ? value.messages : []) messages.push(m);
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) statuses.push(s);
    }
  }
  return { messages, statuses };
}

/** The text of an inbound message, whatever shape it arrived in. */
export function messageText(message) {
  if (message?.type === 'text') return String(message?.text?.body ?? '');
  if (message?.type === 'button') return String(message?.button?.text ?? '');
  if (message?.type === 'interactive') {
    const i = message.interactive || {};
    return String(i.button_reply?.title ?? i.list_reply?.title ?? '');
  }
  return '';
}

export function matchCommand(text) {
  const m = String(text ?? '').trim().replace(/\s+/g, ' ').match(COMMAND_RE);
  if (!m) return null;
  const status = m[3].toLowerCase();
  if (!STATUSES.includes(status)) return null;
  return { ref: `${m[1].toUpperCase()}${m[2]}`, status, note: (m[4] || '').trim() || null };
}

/** Meta sends a unix seconds string; fall back to now when it is absent. */
function stampIso(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
  return new Date().toISOString();
}

// ------------------------------------------------------------------ receipts

/**
 * One bundle per day, appended to and resealed. The receipts already in the
 * file keep their sequence numbers, so an appended bundle still verifies with
 * tools/verify.mjs exactly as a run bundle does.
 */
export async function appendWebhookReceipts(entries, { runsDir = RUNS_DIR, date = todayIso() } = {}) {
  if (!entries.length) return null;
  const runId = `webhook_${date}`;
  const file = path.join(runsDir, `${runId}.evidence.json`);
  let existing = [];
  try {
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(prior.receipts)) existing = prior.receipts;
  } catch {
    existing = [];
  }
  const chain = new ReceiptChain(runId);
  chain.receipts = existing;
  for (const e of entries) chain.add(e.type, e.data || {});
  const bundle = chain.seal();
  await mkdir(runsDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { file, bundle };
}

// ------------------------------------------------------------------ the work

/**
 * Processing is serialised: one batch at a time, so two deliveries arriving
 * together cannot interleave a read-modify-write of the day's bundle or slip
 * past each other's idempotency check.
 */
let queue = Promise.resolve();

export function whenWebhookIdle() {
  return queue.then(
    () => undefined,
    () => undefined
  );
}

function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function record(store, events) {
  if (events.length) await store.appendEvents(events);
}

/**
 * Apply one owner command through the register API, so a status set from
 * WhatsApp writes exactly the same note, receipt and event as the CLI and the
 * dashboard write.
 */
async function applyCommand(store, command, { digestsDir, runsDir }) {
  const result = await setLeadStatus(store, {
    ref: command.ref,
    status: command.status,
    note: command.note,
    digestsDir,
    runsDir,
  });
  return {
    ok: true,
    leadId: result.id,
    name: result.after.name,
    from: result.before.status,
    to: command.status,
    receipt: result.bundle.hash,
    text:
      `${command.ref} ${result.after.name}: ${result.before.status} to ${command.status}. ` +
      `Receipt ${result.bundle.hash.slice(0, 12)}.`,
  };
}

async function replyToOwner({ to, text, env, fetchImpl }) {
  const sent = await sendWhatsAppText({ to, text, env, fetchImpl });
  return sent;
}

/**
 * Handle one verified POST body. Returns a summary so a test (and the local
 * run) can see exactly what was recorded without reading the store.
 */
export async function processWebhookBatch(raw, ctx = {}) {
  const {
    env = process.env,
    storeFactory,
    digestsDir = DIGESTS_DIR,
    runsDir = RUNS_DIR,
    fetchImpl,
    date = todayIso(),
  } = ctx;

  let body = null;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    const entries = [{ type: EVENT_REJECTED, data: { reason: 'body is not JSON', bytes: raw.length } }];
    await appendWebhookReceipts(entries, { runsDir, date });
    return { rejected: 'body is not JSON', inbound: 0, statuses: 0, duplicates: 0, replies: [] };
  }

  const { messages, statuses } = parseChanges(body);
  const store = await storeFactory();
  const receipts = [];
  const events = [];
  const summary = { inbound: 0, statuses: 0, duplicates: 0, replies: [], commands: [] };
  const owner = env.RADAR_TO_WA;

  try {
    for (const message of messages) {
      const id = String(message?.id ?? '');
      const from = String(message?.from ?? '');
      const at = stampIso(message?.timestamp);
      if (!id) {
        receipts.push({ type: EVENT_REJECTED, data: { reason: 'inbound message without an id' } });
        continue;
      }
      if (await store.hasEvent(EVENT_INBOUND, id)) {
        summary.duplicates += 1;
        events.push({ type: EVENT_DUPLICATE, at: new Date().toISOString(), of: EVENT_INBOUND, key: null, messageId: id });
        receipts.push({ type: EVENT_DUPLICATE, data: { of: EVENT_INBOUND, messageId: id } });
        continue;
      }

      const isOwner = sameNumber(from, owner);
      const text = messageText(message);
      // A buyer's words are not ours to keep: only the owner's own text is
      // stored, because only the owner's text is acted on.
      const stored = isOwner ? text.slice(0, 1000) : null;
      summary.inbound += 1;
      events.push({
        type: EVENT_INBOUND,
        at,
        key: id,
        messageId: id,
        from,
        owner: isOwner,
        messageType: message?.type ?? null,
        text: stored,
        textChars: text.length,
      });
      events.push({ type: EVENT_WINDOW, at, key: null, from, lastInboundAt: at });
      receipts.push({
        type: EVENT_INBOUND,
        data: { messageId: id, from, owner: isOwner, messageType: message?.type ?? null, textChars: text.length },
      });

      if (!isOwner) {
        receipts.push({ type: 'whatsapp.reply', data: { messageId: id, sent: false, reason: 'not the owner: the radar never starts or continues a conversation with a buyer' } });
        continue;
      }

      const command = matchCommand(text);
      let replyText;
      if (command) {
        try {
          const applied = await applyCommand(store, command, { digestsDir, runsDir });
          replyText = applied.text;
          summary.commands.push(applied);
          receipts.push({ type: 'whatsapp.command', data: { messageId: id, ref: command.ref, status: command.status, note: command.note, leadId: applied.leadId, from: applied.from, to: applied.to, receipt: applied.receipt } });
        } catch (err) {
          replyText = `${command.ref} ${command.status}: not applied. ${err.message}`;
          summary.commands.push({ ok: false, error: err.message });
          receipts.push({ type: 'whatsapp.command', data: { messageId: id, ref: command.ref, status: command.status, applied: false, error: err.message } });
        }
      } else {
        const digest = await latestDigest(digestsDir);
        replyText = digest.text
          ? bodyText(digest.text, digest.priceSheet)
          : 'No digest has been written yet. The next morning run writes one.';
      }

      const sent = await replyToOwner({ to: owner, text: replyText, env, fetchImpl });
      summary.replies.push({ to: digitsOnly(owner).slice(-4), chars: replyText.length, sent: sent.sent, reason: sent.reason || null });
      receipts.push({
        type: 'whatsapp.reply',
        data: { messageId: id, sent: sent.sent, chars: sent.chars ?? replyText.length, trimmed: sent.trimmed ?? false, status: sent.status ?? null, replyMessageId: sent.messageId ?? null, reason: sent.reason ?? null },
      });
    }

    for (const st of statuses) {
      const id = String(st?.id ?? '');
      const status = String(st?.status ?? '');
      if (!id || !status) {
        receipts.push({ type: EVENT_REJECTED, data: { reason: 'status without an id or a status' } });
        continue;
      }
      const key = `${id}:${status}`;
      if (await store.hasEvent(EVENT_STATUS, key)) {
        summary.duplicates += 1;
        events.push({ type: EVENT_DUPLICATE, at: new Date().toISOString(), of: EVENT_STATUS, key: null, messageId: id, status });
        receipts.push({ type: EVENT_DUPLICATE, data: { of: EVENT_STATUS, messageId: id, status } });
        continue;
      }
      const errors = Array.isArray(st?.errors) ? st.errors : [];
      const error = status === 'failed' && errors.length
        ? { code: errors[0]?.code ?? null, title: errors[0]?.title ?? null, details: errors[0]?.error_data?.details ?? null }
        : null;
      summary.statuses += 1;
      events.push({
        type: EVENT_STATUS,
        at: stampIso(st?.timestamp),
        key,
        messageId: id,
        status,
        recipient: st?.recipient_id ?? null,
        error,
      });
      receipts.push({ type: EVENT_STATUS, data: { messageId: id, status, recipient: st?.recipient_id ?? null, error } });
    }

    await record(store, events);
    const sealed = await appendWebhookReceipts(receipts, { runsDir, date });
    return { ...summary, bundle: sealed?.bundle?.hash || null, file: sealed?.file || null };
  } finally {
    await store.close();
  }
}

/** Record a refused delivery. Called after the 401 has already been written. */
export async function recordRejected(reason, ctx = {}) {
  const { storeFactory, runsDir = RUNS_DIR, date = todayIso() } = ctx;
  const at = new Date().toISOString();
  if (storeFactory) {
    const store = await storeFactory();
    try {
      await store.appendEvents([{ type: EVENT_REJECTED, at, key: null, reason }]);
    } finally {
      await store.close();
    }
  }
  return appendWebhookReceipts([{ type: EVENT_REJECTED, data: { reason } }], { runsDir, date });
}

// ------------------------------------------------------------------ the route

/**
 * GET  - Meta's subscription check. Echo hub.challenge only when the token
 *        matches WA_VERIFY_TOKEN.
 * POST - a signed event batch. Answer 200 immediately, then process.
 */
export async function handleWebhookRequest(req, res, ctx = {}) {
  const { env = process.env, url } = ctx;

  if (req.method === 'GET') {
    const verifyToken = env.WA_VERIFY_TOKEN;
    if (!verifyToken) {
      return plain(res, 503, 'WA_VERIFY_TOKEN is not set, so this webhook cannot be verified yet.\n');
    }
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && safeEqualString(token, verifyToken)) {
      return plain(res, 200, challenge);
    }
    return plain(res, 403, 'verification failed\n');
  }

  if (req.method !== 'POST') {
    return plain(res, 405, `${req.method} is not allowed on the webhook\n`, { Allow: 'GET, POST' });
  }

  const appSecret = env.WA_APP_SECRET;
  if (!appSecret) {
    // No secret means no way to tell Meta from anyone else. Refuse, never accept.
    return plain(res, 503, 'WA_APP_SECRET is not set, so no event can be verified and none is accepted.\n');
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    if (err.tooLarge) return plain(res, 413, 'body too large\n');
    return plain(res, 400, 'could not read the body\n');
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifySignature(raw, signature, appSecret)) {
    const reason = signature ? 'invalid X-Hub-Signature-256' : 'missing X-Hub-Signature-256';
    plain(res, 401, `${reason}\n`);
    await enqueue(() => recordRejected(reason, ctx).catch((e) => {
      process.stderr.write(`[webhook] could not record a rejection: ${e.message}\n`);
    }));
    return undefined;
  }

  // Answer first: Meta retries anything it does not see acknowledged quickly.
  plain(res, 200, 'EVENT_RECEIVED');
  await enqueue(() => processWebhookBatch(raw, ctx).catch((e) => {
    process.stderr.write(`[webhook] batch failed: ${e.stack || e}\n`);
  }));
  return undefined;
}

// ------------------------------------------------------------------ reading back

/** Per-day counts for the dashboard: what arrived, when, and the last failure. */
export function webhookSummary(events) {
  const days = new Map();
  let lastFailure = null;
  for (const e of events) {
    if (!EVENT_KINDS.includes(e.type)) continue;
    const day = String(e.at || '').slice(0, 10);
    if (!day) continue;
    if (!days.has(day)) days.set(day, { day, inbound: 0, statuses: 0, duplicates: 0, rejected: 0, lastAt: null });
    const row = days.get(day);
    if (e.type === EVENT_INBOUND) row.inbound += 1;
    else if (e.type === EVENT_STATUS) row.statuses += 1;
    else if (e.type === EVENT_DUPLICATE) row.duplicates += 1;
    else if (e.type === EVENT_REJECTED) row.rejected += 1;
    else continue;
    if (!row.lastAt || String(e.at) > row.lastAt) row.lastAt = String(e.at);
    if (e.type === EVENT_STATUS && e.status === 'failed') {
      const line = `${e.at} ${e.messageId} failed${e.error?.code ? ` (${e.error.code} ${e.error.title || ''})` : ''}`.trim();
      if (!lastFailure || String(e.at) > lastFailure.at) lastFailure = { at: String(e.at), line };
    }
    if (e.type === EVENT_REJECTED && (!lastFailure || String(e.at) > lastFailure.at)) {
      lastFailure = { at: String(e.at), line: `${e.at} rejected: ${e.reason}` };
    }
  }
  return {
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    lastFailure,
  };
}

/** The open 24-hour customer-service window, or null when none is fresh. */
export function openWindow(events, now = new Date()) {
  let latest = null;
  for (const e of events) {
    if (e.type !== EVENT_WINDOW) continue;
    const at = e.lastInboundAt || e.at;
    if (!at) continue;
    if (!latest || String(at) > String(latest.at)) latest = { at: String(at), from: e.from || null };
  }
  if (!latest) return null;
  const opensUntil = new Date(new Date(latest.at).getTime() + WINDOW_MS);
  if (!(opensUntil.getTime() > now.getTime())) return null;
  return { from: latest.from, lastInboundAt: latest.at, until: opensUntil.toISOString() };
}
