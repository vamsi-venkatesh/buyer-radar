// What became of the morning digest, including the part that arrives late.
//
// A 200 from the WhatsApp Cloud API is not a delivery. The API answers with a
// message id and Meta fails the message minutes later on the webhook - 131047,
// the closed 24-hour customer-service window, almost every time. Until the
// failure arrives the run has already finished, written `digest.delivered` and
// gone; without this module the dashboard would carry a tick for a message
// nobody received.
//
// So every id the Cloud API accepts is written down as a delivery record the
// webhook can look up by id. When the failed status arrives:
//
//   - the record is rewritten to sent:false with failedLater and the code;
//   - if the failed message was the TEXT and no template was tried in the
//     morning, the approved template is sent once, here, as the fallback;
//   - if the template fails too it is recorded and the email - which already
//     went out with the same digest - stands as the delivery of record.
//
// Nothing here ever messages a buyer, and nothing is queued for a retry loop:
// one text, at most one template, then the truth on the page.

import { DIGESTS_DIR } from './lib/paths.mjs';
import { digestForDate } from './lib/digest-files.mjs';
import { sendDigestTemplate } from './deliver.mjs';
import { WINDOW_CLOSED_CODE } from './orders.mjs';

/** One row per accepted WhatsApp message, keyed on the id Meta gave it. */
export const EVENT_DIGEST_MESSAGE = 'digest.message';
/** A template sent from the webhook because the morning's text failed later. */
export const EVENT_DIGEST_RESENT = 'digest.resent';

/** The day a delivery event belongs to, from the payload, the run id, or the clock. */
export function deliveryDate(event) {
  if (!event) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ''))) return String(event.date);
  const fromRun = String(event.runId || '').match(/^delivery_(\d{4}-\d{2}-\d{2})$/);
  if (fromRun) return fromRun[1];
  const at = String(event.at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : null;
}

/**
 * Write down every message id the Cloud API accepted for this morning, so a
 * delivery status arriving hours later can be matched back to the digest it was
 * about. Returns the rows written; an attempt Meta refused outright has no id
 * and writes nothing - the run already recorded that refusal as digest.not_sent.
 */
export async function recordDigestMessages(
  store,
  { date, runId = null, cities = null, whatsapp = null, emailSent = false } = {}
) {
  const ids = whatsapp && Array.isArray(whatsapp.messageIds) ? whatsapp.messageIds : [];
  if (!ids.length || typeof store.appendEvents !== 'function') return [];
  const at = new Date().toISOString();
  const events = ids.map(({ kind, messageId }) => ({
    type: EVENT_DIGEST_MESSAGE,
    at,
    key: messageId,
    runId,
    messageId,
    kind,
    date,
    cities: Array.isArray(cities) && cities.length ? [...cities] : null,
    // Whether the morning already spent its one template attempt. It has if the
    // text was refused in the POST and the template carried the digest instead.
    templateAttempted: Boolean(whatsapp.templateAttempted),
    // The email went with the same digest; it is what stands if WhatsApp fails.
    emailSent: Boolean(emailSent),
    sent: true,
    failedLater: false,
    errorCode: null,
  }));
  await store.appendEvents(events);
  return events;
}

function why(code) {
  if (code === WINDOW_CLOSED_CODE) {
    return `WhatsApp accepted the digest and then failed it: Meta error ${code}, more than 24 hours have passed since the owner last replied to that number.`;
  }
  return `WhatsApp accepted the digest and then failed it${code ? `: Meta error ${code}` : ''}.`;
}

/**
 * A digest message the Cloud API accepted and Meta then failed.
 *
 * Returns null when the failed id is not a digest message of ours, or when the
 * record has already been rewritten - Meta redelivers a status it thinks was
 * not acknowledged, and a second callback for the same id must change nothing.
 */
export async function digestFailedLater(
  store,
  { messageId, error = null },
  { env = process.env, fetchImpl, digestsDir = DIGESTS_DIR } = {}
) {
  if (!messageId || typeof store.getEvent !== 'function' || typeof store.updateEvent !== 'function') return null;
  const record = await store.getEvent(EVENT_DIGEST_MESSAGE, messageId);
  if (!record) return null;
  if (record.failedLater) return null;

  const code = error && error.code !== undefined && error.code !== null ? error.code : null;
  const at = new Date().toISOString();
  const reason = why(code);
  const patch = {
    sent: false,
    failedLater: true,
    errorCode: code,
    windowClosed: code === WINDOW_CLOSED_CODE,
    failedAt: at,
    reason,
  };

  const date = deliveryDate(record);
  const emailSent = Boolean(record.emailSent);
  const out = {
    date,
    messageId,
    kind: record.kind || null,
    errorCode: code,
    emailSent,
    resent: false,
    resentMessageId: null,
    reason,
  };

  // (b) The text failed and the morning never tried the template. One attempt,
  // now, against the digest of the day this message was about - not the newest
  // one, which may already be a different morning's leads.
  const canTry = record.kind === 'text' && !record.templateAttempted;
  let template = null;
  if (canTry) {
    const digest = await digestForDate(date, digestsDir);
    template = await sendDigestTemplate({
      date: date || undefined,
      digestText: digest.text || '',
      priceSheet: digest.priceSheet || '',
      env,
      fetchImpl,
    });
  }

  if (template && template.sent && template.messageId) {
    out.resent = true;
    out.resentMessageId = template.messageId;
    out.state = 'template sent';
    patch.resentAs = template.messageId;
    await store.updateEvent(EVENT_DIGEST_MESSAGE, messageId, patch);
    // The template is a message like any other: it gets its own record, so if
    // Meta fails this one too the webhook finds it and records that as well.
    // templateAttempted is true on it, which is what stops a second attempt.
    await store.appendEvents([
      {
        type: EVENT_DIGEST_MESSAGE,
        at,
        key: template.messageId,
        runId: record.runId || null,
        messageId: template.messageId,
        kind: 'template',
        date,
        cities: record.cities || null,
        templateAttempted: true,
        emailSent,
        sent: true,
        failedLater: false,
        errorCode: null,
        resentFor: messageId,
      },
      {
        type: EVENT_DIGEST_RESENT,
        at,
        key: `${messageId}:resent`,
        runId: record.runId || null,
        date,
        failedMessageId: messageId,
        messageId: template.messageId,
        via: 'template',
        template: template.template,
        errorCode: code,
        emailSent,
      },
    ]);
    return out;
  }

  // (c) Either the template was refused as well, or there was no second attempt
  // to make. Either way the email that went with this digest is the delivery of
  // record, and the record says so rather than showing a tick.
  const templateCode = template && template.error && template.error.code !== undefined ? template.error.code : null;
  if (template) {
    patch.templateAttempted = true;
    patch.templateFailed = true;
    patch.templateErrorCode = templateCode;
    patch.templateReason = template.body || (template.status ? `HTTP ${template.status}` : 'not sent');
    out.templateFailed = true;
    out.templateErrorCode = templateCode;
  }
  out.state = emailSent ? 'email only' : 'not delivered';
  patch.deliveredBy = emailSent ? 'email' : 'none';
  await store.updateEvent(EVENT_DIGEST_MESSAGE, messageId, patch);
  await store.appendEvents([
    {
      type: EVENT_DIGEST_RESENT,
      at,
      key: `${messageId}:resent`,
      runId: record.runId || null,
      date,
      failedMessageId: messageId,
      messageId: null,
      via: template ? 'template refused' : 'none',
      template: template ? template.template : null,
      errorCode: code,
      templateErrorCode: templateCode,
      emailSent,
      deliveredBy: emailSent ? 'email' : 'none',
    },
  ]);
  return out;
}

// ------------------------------------------------------- reading it back out

/**
 * What the owner was actually sent, per day, for the dashboard.
 *
 * Built from three kinds of event and in this order, because the later ones
 * correct the earlier: `digest.delivered` and `digest.not_sent` are what the
 * run believed at the time, and `digest.message` is what Meta said afterwards.
 * Where they disagree the message record wins - it is the one that knows.
 */
export function digestDeliveries(events) {
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) {
      days.set(d, {
        date: d,
        email: null,
        whatsapp: null,
        whatsappFailedLater: false,
        errorCode: null,
        resentMessageId: null,
        cities: null,
      });
    }
    return days.get(d);
  };

  for (const e of events || []) {
    const d = deliveryDate(e);
    if (!d) continue;
    if (e.type === 'digest.delivered') {
      const row = day(d);
      if (e.channel === 'email') row.email = { sent: true };
      if (e.channel === 'whatsapp') row.whatsapp = { sent: true, via: e.via || null };
      if (Array.isArray(e.cities) && e.cities.length) row.cities = e.cities;
    } else if (e.type === 'digest.not_sent') {
      const row = day(d);
      if (e.channel === 'email' && !row.email) row.email = { sent: false, reason: e.reason || null };
      if (e.channel === 'whatsapp' && !(row.whatsapp && row.whatsapp.sent)) {
        row.whatsapp = { sent: false, reason: e.reason || null };
        row.errorCode = e.errorCode ?? row.errorCode;
      }
      if (Array.isArray(e.cities) && e.cities.length && !row.cities) row.cities = e.cities;
    } else if (e.type === EVENT_DIGEST_MESSAGE && e.failedLater) {
      const row = day(d);
      row.whatsappFailedLater = true;
      row.errorCode = e.errorCode ?? row.errorCode;
      row.whatsapp = { sent: false, failedLater: true, reason: e.reason || null };
      if (e.resentAs) row.resentMessageId = e.resentAs;
    } else if (e.type === EVENT_DIGEST_MESSAGE && e.sent && e.resentFor) {
      const row = day(d);
      // A template that went out from the webhook and has not itself failed.
      row.whatsapp = { sent: true, via: 'template', resent: true };
      row.resentMessageId = e.messageId || row.resentMessageId;
    }
  }

  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * One honest line for a day's delivery. It never says a channel delivered when
 * Meta later said it did not.
 */
export function deliveryLabel(row) {
  if (!row) return 'nothing recorded';
  const emailSent = Boolean(row.email && row.email.sent);
  const waSent = Boolean(row.whatsapp && row.whatsapp.sent);
  const code = row.errorCode ?? null;

  if (row.whatsappFailedLater && !waSent) {
    const failed = `WhatsApp failed: ${code ?? 'no code'}`;
    if (row.resentMessageId) {
      return emailSent
        ? `email, then the template resent (${failed})`
        : `template resent (${failed})`;
    }
    return emailSent ? `email only (${failed})` : `not delivered (${failed})`;
  }
  if (waSent && emailSent) return row.whatsapp.resent ? 'email, then the template resent' : 'email and WhatsApp';
  if (waSent) return row.whatsapp.via === 'template' ? 'WhatsApp (template)' : 'WhatsApp';
  if (emailSent) {
    const reason = row.whatsapp && row.whatsapp.reason ? row.whatsapp.reason : null;
    return reason ? `email only (${reason})` : 'email only';
  }
  if (row.email && row.email.reason) return `not delivered: ${row.email.reason}`;
  if (row.whatsapp && row.whatsapp.reason) return `not delivered: ${row.whatsapp.reason}`;
  return 'nothing recorded';
}
