// Delivery hooks.
//
// These build the message the owner would receive and hand it to a channel.
// When a channel is not configured - no SMTP URL, no WhatsApp token - the
// message is written to outbox/ and the result says "not sent" and why. Nothing
// is ever queued for a later retry and nothing is sent to a buyer: the only
// recipient is the owner's own address, set by him, in his own environment.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLIENT } from './config.mjs';
import { ROOT } from './lib/paths.mjs';
import { todayIso } from './lib/normalise.mjs';
import { sendMail } from './lib/smtp.mjs';

export const OUTBOX_DIR = path.join(ROOT, 'outbox');
export const CHANNELS = ['email', 'whatsapp'];
export const WHATSAPP_API = 'https://graph.facebook.com/v20.0';
// The Cloud API rejects a text body over 4096 characters outright, so a long
// digest is trimmed here and the result says it was trimmed.
export const WHATSAPP_MAX_CHARS = 4096;

const RFC5322_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC5322_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 section 3.3 date, always in +0000 so it never depends on the host clock's zone. */
export function rfc5322Date(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${RFC5322_DAYS[date.getUTCDay()]}, ${p(date.getUTCDate())} ${RFC5322_MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`
  );
}

/** Header values are single-line by definition; fold nothing, just refuse injection. */
function headerValue(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * The message body is the digest, a blank line, then the price sheet - the same
 * two texts the run already wrote to digests/.
 */
export function bodyText(digestText, priceSheet) {
  return [String(digestText || '').trim(), String(priceSheet || '').trim()]
    .filter(Boolean)
    .join('\n\n');
}

/** A complete RFC 5322 message: headers, blank line, UTF-8 text body. */
export function buildEmailMessage({
  date = todayIso(),
  digestText = '',
  priceSheet = '',
  from,
  to,
  now = new Date(),
  messageId = `${randomUUID()}@buyer-radar`,
}) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(headerValue);
  const headers = [
    `From: ${headerValue(from)}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${CLIENT.digest.title} - ${headerValue(date)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${headerValue(messageId)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
    'X-Buyer-Radar: digest',
  ];
  return `${headers.join('\n')}\n\n${bodyText(digestText, priceSheet)}\n`;
}

export function trimForWhatsApp(text, max = WHATSAPP_MAX_CHARS) {
  const t = String(text);
  if (t.length <= max) return { text: t, trimmed: false };
  const marker = '\n[trimmed - open the dashboard for the rest]';
  return { text: `${t.slice(0, max - marker.length).trimEnd()}${marker}`, trimmed: true };
}

export function buildWhatsAppPayload({ to, text }) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'text',
    text: { preview_url: false, body: String(text) },
  };
}

async function writeOutbox(name, contents, { outboxDir = OUTBOX_DIR } = {}) {
  await mkdir(outboxDir, { recursive: true });
  const file = path.join(outboxDir, name);
  await writeFile(file, contents, 'utf8');
  return file;
}

/**
 * Build the email and, if RADAR_SMTP_URL and RADAR_TO are both set, send it over
 * TLS. Otherwise write it to outbox/<date>.eml and report why it was not sent.
 * Returns a plain result object; it never throws for a missing configuration.
 */
export async function deliverEmail({
  date = todayIso(),
  digestText = '',
  // Email has no 1,500-character cap, so it carries the uncapped sheet - every
  // posted requirement with its document link - and falls back to the WhatsApp
  // text only when a run produced no sheet.
  fullSheet = null,
  priceSheet = '',
  env = process.env,
  outboxDir = OUTBOX_DIR,
  now = new Date(),
  connect,
  send = sendMail,
} = {}) {
  const smtpUrl = env.RADAR_SMTP_URL;
  const to = env.RADAR_TO;
  const from = env.RADAR_FROM || to || CLIENT.business.contactEmail;
  const message = buildEmailMessage({ date, digestText: fullSheet || digestText, priceSheet, from, to: to || from, now });
  const bytes = Buffer.byteLength(message, 'utf8');

  const notSent = async (reason) => ({
    channel: 'email',
    sent: false,
    reason,
    file: path.relative(ROOT, await writeOutbox(`${date}.eml`, message, { outboxDir })),
    bytes,
  });

  if (!smtpUrl) return notSent('not sent: RADAR_SMTP_URL unset');
  if (!to) return notSent('not sent: RADAR_TO unset');

  try {
    const result = await send({ url: smtpUrl, from, to, message, connect });
    return {
      channel: 'email',
      sent: true,
      to,
      host: result.host,
      port: result.port,
      bytes,
      transcript: result.transcript,
    };
  } catch (err) {
    return {
      ...(await notSent(`not sent: ${err.name}: ${err.message}`)),
      error: `${err.name}: ${err.message}`,
    };
  }
}

/**
 * Post the digest as a WhatsApp Cloud API text message. Without
 * WA_PHONE_NUMBER_ID, WA_TOKEN and RADAR_TO_WA it writes the exact request it
 * would have made to outbox/<date>.whatsapp.json and reports "not sent". The
 * token is never written to that file.
 */

/** Parameters for the approved WhatsApp digest template ( date, leads, phones, top three with numbers, short prices. No newlines (Meta rejects them). */
export function templateParams({ date = todayIso(), digestText = '', priceSheet = '', stats = {} } = {}) {
  const clean = (s, n) => String(s).replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);
  const lines = digestText.split('\n');
  const leads = [];
  for (let i = 0; i < lines.length && leads.length < 3; i++) {
    const m = lines[i].match(/^L\d+\s+(.+?)\s+-\s+\S/);
    if (!m) continue;
    const phone = (lines[i + 1] || '').match(/\+\d[\d\s-]{7,}\d/);
    leads.push(phone ? `${m[1]} ${phone[0].replace(/\s+/g, '')}` : m[1]);
  }
  const shown = lines.filter((l) => /^L\d+\s/.test(l)).length;
  const prices = priceSheet.split('\n').filter((l) => /Rs \d/.test(l)).slice(0, 4).map((l) => {
    const m = l.match(/^([^:~]+)\s*~?:\s*Rs\s*(\d+)/);
    return m ? `${m[1].trim().toLowerCase()} Rs ${m[2]}` : null;
  }).filter(Boolean);
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return [
    clean(day, 40),
    clean(stats.leads ?? shown, 10),
    clean(stats.withPhone ?? shown, 10),
    clean(leads.join(', ') || 'none today', 400),
    clean(prices.length ? prices.join(', ') + ' per quintal' : 'no mandi quotes today', 300),
  ];
}
/**
 * Send one WhatsApp text message to the owner. This is the single outbound
 * text path: the daily digest and the webhook's replies both go through it, so
 * there is one place that knows the endpoint, the trimming rule and the token.
 *
 * WA_FAKE_FETCH_URL is a local test hook and is off unless it is set: with it
 * set the request goes to that URL instead of the Cloud API, which is how the
 * suite and a local run observe an outbound reply without sending one. The
 * token is only ever put in a header, never written to a file or logged.
 */
export async function sendWhatsAppText({ to, text, env = process.env, fetchImpl } = {}) {
  const fake = env.WA_FAKE_FETCH_URL || '';
  const phoneNumberId = env.WA_PHONE_NUMBER_ID;
  const token = env.WA_TOKEN;
  const { text: body, trimmed } = trimForWhatsApp(String(text ?? ''));
  const recipient = String(to ?? '').replace(/^\+/, '');

  if (!recipient) return { channel: 'whatsapp', sent: false, reason: 'not sent: no recipient', chars: body.length, trimmed };
  if (!fake) {
    const missing = [!phoneNumberId && 'WA_PHONE_NUMBER_ID', !token && 'WA_TOKEN'].filter(Boolean);
    if (missing.length) {
      return { channel: 'whatsapp', sent: false, reason: `not sent: ${missing.join(', ')} unset`, chars: body.length, trimmed };
    }
  }

  const url = fake || `${WHATSAPP_API}/${phoneNumberId}/messages`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = buildWhatsAppPayload({ to: recipient, text: body });
  const doFetch = fetchImpl || globalThis.fetch;

  try {
    const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const responseText = await res.text();
    let messageId = null;
    try {
      messageId = JSON.parse(responseText)?.messages?.[0]?.id || null;
    } catch {
      messageId = null;
    }
    return {
      channel: 'whatsapp',
      sent: Boolean(res.ok),
      via: fake ? 'fake' : 'cloud-api',
      status: res.status,
      messageId,
      chars: body.length,
      trimmed,
      reason: res.ok ? null : `not sent: WhatsApp API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      channel: 'whatsapp',
      sent: false,
      via: fake ? 'fake' : 'cloud-api',
      chars: body.length,
      trimmed,
      reason: `not sent: ${err.name}: ${err.message}`,
    };
  }
}

export async function deliverWhatsApp({
  date = todayIso(),
  digestText = '',
  priceSheet = '',
  stats = {},
  env = process.env,
  outboxDir = OUTBOX_DIR,
  fetchImpl,
} = {}) {
  const phoneNumberId = env.WA_PHONE_NUMBER_ID;
  const templateName = env.WA_TEMPLATE || '';
  const templateLang = env.WA_TEMPLATE_LANG || 'en';
  const token = env.WA_TOKEN;
  const to = env.RADAR_TO_WA;
  const { text, trimmed } = trimForWhatsApp(bodyText(digestText, priceSheet));
  const payload = buildWhatsAppPayload({ to: to || '<RADAR_TO_WA unset>', text });
  const url = `${WHATSAPP_API}/${phoneNumberId || '<WA_PHONE_NUMBER_ID unset>'}/messages`;

  let templateResult = null;
  const notSent = async (reason) => ({
    channel: 'whatsapp',
    sent: false,
    template: templateResult,
    reason,
    file: path.relative(
      ROOT,
      await writeOutbox(
        `${date}.whatsapp.json`,
        `${JSON.stringify({ method: 'POST', url, body: payload }, null, 2)}\n`,
        { outboxDir }
      )
    ),
    chars: text.length,
    trimmed,
  });

  const missing = [
    !phoneNumberId && 'WA_PHONE_NUMBER_ID',
    !token && 'WA_TOKEN',
    !to && 'RADAR_TO_WA',
  ].filter(Boolean);
  if (missing.length) return notSent(`not sent: ${missing.join(', ')} unset`);

  const doFetch = fetchImpl || globalThis.fetch;
  if (templateName) {
    const params = templateParams({ date, digestText, priceSheet, stats });
    const tpl = {
      messaging_product: 'whatsapp',
      to: String(to).replace(/^\+/, ''),
      type: 'template',
      template: { name: templateName, language: { code: templateLang }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] },
    };
    try {
      const r = await doFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tpl) });
      const rb = await r.text();
      let id = null;
      try { id = JSON.parse(rb)?.messages?.[0]?.id || null; } catch { /* ignore */ }
      templateResult = { template: templateName, sent: r.ok, status: r.status, messageId: id, error: r.ok ? null : rb.slice(0, 200) };
    } catch (err) {
      templateResult = { template: templateName, sent: false, error: String(err.message || err).slice(0, 200) };
    }
  }
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const bodyTextResponse = await res.text();
    if (!res.ok) {
      return {
        ...(await notSent(`not sent: WhatsApp API returned HTTP ${res.status}`)),
        status: res.status,
      };
    }
    let messageId = null;
    try {
      messageId = JSON.parse(bodyTextResponse)?.messages?.[0]?.id || null;
    } catch {
      messageId = null;
    }
    return { channel: 'whatsapp', sent: true, to, status: res.status, messageId, chars: text.length, trimmed, template: templateResult };
  } catch (err) {
    return {
      ...(await notSent(`not sent: ${err.name}: ${err.message}`)),
      error: `${err.name}: ${err.message}`,
    };
  }
}

export function parseChannels(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const c of list) {
    if (!CHANNELS.includes(c)) throw new Error(`unknown delivery channel: ${c} (known: ${CHANNELS.join(', ')})`);
  }
  return [...new Set(list)];
}

/** Run every requested channel in order and return one result per channel. */
export async function deliver(channels, payload = {}) {
  const results = [];
  for (const channel of channels) {
    if (channel === 'email') results.push(await deliverEmail(payload));
    else if (channel === 'whatsapp') results.push(await deliverWhatsApp(payload));
  }
  return results;
}
