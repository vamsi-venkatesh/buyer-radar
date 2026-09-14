// The order loop.
//
// A buyer fills the order form on the client's own site. The site stores the
// request and posts it to the automation layer; that validates it, emails the
// buyer an acknowledgement and the business an alert, and posts the same order
// here. This file is what the radar does with it:
//
//   1. record the order, once, keyed on the site's own reference;
//   2. put the buyer in the register as a won lead, matched on his phone
//      number - or created, with the order as the licence to hold him;
//   3. tell the owner, on WhatsApp, and by email when WhatsApp refuses.
//
// It never messages the buyer. The only outbound address in this file is the
// owner's own, exactly as everywhere else in this codebase.

import { randomUUID } from 'node:crypto';
import { CLIENT } from './config.mjs';
import { leadId } from './lib/hash.mjs';
import { appendDayBundle } from './lib/receipts.mjs';
import { RUNS_DIR } from './lib/paths.mjs';
import {
  normalisePhone,
  normaliseEmail,
  normaliseName,
  normaliseCity,
  todayIso,
  tidy,
} from './lib/normalise.mjs';
import { sendWhatsAppText, deliverAlertEmail } from './deliver.mjs';

export const ORDER_SOURCE = 'site-order';
/**
 * The supplier's own site, from the client profile. It names where an order was
 * placed, in the licence the register holds the buyer under and in the note on
 * the won lead, so an order can always be traced back to its origin.
 */
export const ORDER_SITE = CLIENT.business.site || 'the site';
/** The licence the register holds a buyer under when he ordered himself. */
export const ORDER_LICENCE = `the buyer's own order on ${ORDER_SITE}`;
export const EVENT_ORDER_RECEIVED = 'order.received';
export const EVENT_LEAD_WON = 'lead.won';
export const EVENT_ORDER_ALERT = 'order.alert';
/** Meta's code for "outside the 24-hour customer-service window". */
export const WINDOW_CLOSED_CODE = 131047;

/** What the form's buyer-type answers mean in the register's own vocabulary. */
const SEGMENT_BY_BUSINESS_TYPE = [
  [/wholesal|mandi|apmc|trade/i, 'wholesale'],
  [/restaurant|qsr|cafe|café|dhaba|food\s*court/i, 'restaurant'],
  [/hotel|resort/i, 'hotel'],
  [/cater/i, 'caterer'],
  [/retail|supermarket|grocer|kirana|store/i, 'retailer'],
  [/manufactur|process|factory|packhouse|pack\s*house/i, 'food_manufacturer'],
  [/distribut|supplier|vendor/i, 'distributor'],
  [/hospital|hostel|canteen|school|college|university|institut|corporate/i, 'institution'],
];

export function segmentFromBusinessType(raw) {
  const t = String(raw || '');
  for (const [re, segment] of SEGMENT_BY_BUSINESS_TYPE) if (re.test(t)) return segment;
  return 'other';
}

const str = (v, max) => (typeof v === 'string' ? tidy(v, max) : v === null || v === undefined ? '' : tidy(String(v), max));

/**
 * The same, but a buyer's own line breaks survive. He typed "20 kg garlic" on
 * one line and "5 kg broccoli" on the next because they are two lines of an
 * order, and collapsing them into one would lose what he meant.
 */
function multiline(v, max) {
  if (v === null || v === undefined) return '';
  return String(v)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
}

/**
 * Accept either the envelope the site's Worker posts to n8n
 * ({ eventType, eventId, occurredAt, source, order }) or a bare order object,
 * so the same endpoint works whether n8n forwards the envelope or only the
 * order it validated.
 */
export function unwrapOrder(body) {
  if (body && typeof body === 'object' && body.order && typeof body.order === 'object') {
    return { order: body.order, envelope: { eventType: body.eventType ?? null, eventId: body.eventId ?? null, occurredAt: body.occurredAt ?? null, source: body.source ?? null } };
  }
  return { order: body && typeof body === 'object' ? body : {}, envelope: {} };
}

/**
 * Normalise one order into the record the store holds. Throws with the field
 * names when the body is not an order - a 400 that says what is missing is
 * worth more than a 200 that silently drops it.
 *
 * `frequency` is the site's `schedule` field under the name the register and
 * the digest already use; both spellings are accepted on the way in.
 */
export function normaliseOrder(body, { receivedAt = new Date().toISOString() } = {}) {
  const { order, envelope } = unwrapOrder(body);
  const id = str(order.orderId ?? order.order_id ?? order.id, 64);
  const products = Array.isArray(order.products)
    ? order.products.map((p) => str(p, 100)).filter(Boolean).slice(0, 50)
    : String(order.products || '').split(',').map((p) => tidy(p, 100)).filter(Boolean).slice(0, 50);
  const orderDetails = multiline(order.orderDetails ?? order.order_details, 1500);

  const missing = [];
  if (!id) missing.push('orderId');
  if (!orderDetails && !products.length) missing.push('orderDetails or products');
  if (missing.length) throw new Error(`not an order: missing ${missing.join(', ')}`);

  return {
    id,
    createdAt: str(order.createdAt ?? order.created_at, 40) || receivedAt,
    receivedAt,
    contactName: str(order.contactName ?? order.contact_name, 80) || null,
    businessName: str(order.businessName ?? order.business_name ?? order.business, 120) || null,
    phone: str(order.phone, 24) || null,
    email: normaliseEmail(order.email),
    city: str(order.city, 120) || null,
    businessType: str(order.businessType ?? order.business_type ?? order.buyer_type, 80) || null,
    products,
    orderDetails: orderDetails || null,
    frequency: str(order.frequency ?? order.schedule, 80) || null,
    volume: str(order.volume, 100) || null,
    neededBy: str(order.neededBy ?? order.needed_by, 10) || null,
    notes: multiline(order.notes, 1000) || null,
    sourcePath: str(order.sourcePath ?? order.source_path, 200) || null,
    status: str(order.status, 60) || 'new-awaiting-confirmation',
    leadId: null,
    alert: {},
    raw: { ...envelope, source: envelope.source || str(order.source, 80) || ORDER_SITE },
  };
}

/**
 * The order as lines: the products chosen on the form first, then whatever the
 * buyer typed. Used for the owner's message and for the lead's why_now, so the
 * two say the same thing.
 */
export function orderLines(order) {
  const lines = [];
  if (order.products && order.products.length) lines.push(order.products.join(', '));
  for (const line of String(order.orderDetails || '').split(/\r?\n/)) {
    const t = tidy(line, 200);
    if (t) lines.push(t);
  }
  return lines;
}

/** "Ordered on 2026-09-14: 20 kg peeled garlic; 10 kg broccoli" - first three lines, no more. */
export function whyNowFromOrder(order) {
  const date = String(order.createdAt || order.receivedAt || '').slice(0, 10) || todayIso();
  const lines = orderLines(order).slice(0, 3);
  return tidy(`Ordered on ${date}: ${lines.join('; ')}`, 120);
}

/** The message the owner gets. Everything he needs to ring the buyer back. */
export function alertText(order) {
  const lines = orderLines(order);
  return [
    `NEW ORDER - ${order.id}`,
    order.businessName ? `Buyer: ${order.businessName}` : null,
    order.businessType ? `Business: ${order.businessType}` : null,
    order.city ? `City: ${order.city}` : null,
    order.contactName ? `Contact: ${order.contactName}` : null,
    order.phone ? `Phone: ${order.phone}` : null,
    '',
    lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (no lines given)',
    '',
    order.frequency ? `Frequency: ${order.frequency}` : null,
    order.volume ? `Volume: ${order.volume}` : null,
    order.neededBy ? `Needed by: ${order.neededBy}` : null,
    order.notes ? `Notes: ${order.notes}` : null,
    '',
    'Ring the buyer to confirm availability, price, packing and delivery. Nothing has been promised and no payment has been taken.',
  ]
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find the buyer already in the register: the phone number first, because it is
 * the one field a buyer types the same way twice, and the trading name with the
 * city only when there is no phone match.
 */
export function matchLead(leads, order) {
  const phone = normalisePhone(order.phone);
  if (phone) {
    const byPhone = leads.find((l) => l.kind !== 'price' && normalisePhone(l.phone) === phone);
    if (byPhone) return { lead: byPhone, matchedOn: 'phone' };
  }
  const name = normaliseName(order.businessName);
  if (name) {
    const city = normaliseCity(order.city);
    const byName = leads.find(
      (l) => l.kind !== 'price' && normaliseName(l.name) === name && normaliseCity(l.city) === city
    );
    if (byName) return { lead: byName, matchedOn: 'name+city' };
  }
  return { lead: null, matchedOn: null };
}

/** The register entry for a buyer who arrived by ordering rather than by being found. */
export function leadFromOrder(order) {
  const phone = normalisePhone(order.phone);
  const external = phone || `${normaliseName(order.businessName)}|${normaliseCity(order.city)}`;
  const now = order.receivedAt || new Date().toISOString();
  return {
    id: leadId(ORDER_SOURCE, external),
    kind: 'buyer',
    segment: segmentFromBusinessType(order.businessType),
    segment_source: segmentFromBusinessType(order.businessType),
    segment_model: null,
    opener_model: null,
    name: tidy(order.businessName || order.contactName || order.id, 160),
    city: order.city || null,
    state: null,
    address: null,
    phone,
    email: normaliseEmail(order.email),
    website: null,
    why_now: whyNowFromOrder(order),
    source: ORDER_SOURCE,
    source_url: null,
    licence: ORDER_LICENCE,
    first_seen: now,
    last_seen: now,
    // A buyer who has ordered is not a lead to be scored against the ones that
    // were merely found; he is the top of the register by definition.
    score: 100,
    status: 'won',
    notes: null,
    extra: { whyNowDate: String(order.createdAt || now).slice(0, 10), rawPhone: order.phone || null, orders: [] },
  };
}

/** The order, as it is kept on the lead's own record. */
export function orderSummary(order) {
  return {
    orderId: order.id,
    at: order.createdAt || order.receivedAt,
    lines: orderLines(order),
    frequency: order.frequency || null,
    volume: order.volume || null,
    neededBy: order.neededBy || null,
    notes: order.notes || null,
    sourcePath: order.sourcePath || null,
  };
}

/**
 * Put the buyer in the register. Matched or created, he comes out of here as a
 * won lead carrying this order in extra.orders and this order in why_now.
 */
export async function upsertOrderLead(store, order) {
  const leads = await store.allLeads();
  const { lead, matchedOn } = matchLead(leads, order);
  const summary = orderSummary(order);
  const now = order.receivedAt || new Date().toISOString();

  if (!lead) {
    const created = leadFromOrder(order);
    created.extra.orders = [summary];
    await store.putLeads([...leads, created]);
    return { lead: created, created: true, matchedOn: null, statusFrom: null, statusTo: 'won' };
  }

  const extra = { ...(lead.extra || {}) };
  const orders = Array.isArray(extra.orders) ? [...extra.orders] : [];
  // Idempotent in the lead as well as in the orders table: the same reference
  // is never appended twice.
  if (!orders.some((o) => o && o.orderId === summary.orderId)) orders.push(summary);
  extra.orders = orders;
  const note = `${todayIso()} won: order ${order.id} on ${ORDER_SITE}`;
  const patch = {
    status: 'won',
    why_now: whyNowFromOrder(order),
    last_seen: now,
    extra,
    notes: [lead.notes, note].filter(Boolean).join('\n'),
  };
  if (!lead.phone && normalisePhone(order.phone)) patch.phone = normalisePhone(order.phone);
  if (!lead.email && normaliseEmail(order.email)) patch.email = normaliseEmail(order.email);
  const after = await store.updateLead(lead.id, patch);
  return { lead: after || { ...lead, ...patch }, created: false, matchedOn, statusFrom: lead.status, statusTo: 'won' };
}

/**
 * Tell the owner. WhatsApp text first, because that is where he reads. When
 * Meta refuses - 131047 is the closed 24-hour window, and it is the refusal
 * this will meet most mornings - the refusal is recorded with its code and the
 * same text goes out by email to RADAR_TO instead.
 */
export async function alertOwner(order, { env = process.env, fetchImpl, outboxDir, smtpConnect } = {}) {
  const text = alertText(order);
  const to = env.RADAR_TO_WA || '';
  const whatsapp = to
    ? await sendWhatsAppText({ to, text, env, fetchImpl })
    : { sent: false, reason: 'not sent: RADAR_TO_WA unset', chars: text.length, error: null };

  const result = {
    text: { chars: text.length },
    whatsapp: {
      sent: Boolean(whatsapp.sent),
      status: whatsapp.status ?? null,
      messageId: whatsapp.messageId ?? null,
      errorCode: whatsapp.error?.code ?? null,
      windowClosed: (whatsapp.error?.code ?? null) === WINDOW_CLOSED_CODE,
      reason: whatsapp.reason || null,
    },
    email: null,
    channel: whatsapp.sent ? 'whatsapp' : null,
  };

  if (whatsapp.sent) return result;

  const email = await deliverAlertEmail({
    subject: `New order ${order.id}`,
    text: `${text}\n\nWhatsApp did not carry this alert: ${result.whatsapp.reason || 'no WhatsApp channel configured'}\n`,
    name: `order-${order.id}`,
    env,
    ...(outboxDir ? { outboxDir } : {}),
    ...(smtpConnect ? { connect: smtpConnect } : {}),
  });
  result.email = { sent: Boolean(email.sent), to: email.sent ? email.to : null, reason: email.reason || null, file: email.file || null };
  result.channel = email.sent ? 'email' : 'none';
  return result;
}

/**
 * A WhatsApp message the Cloud API accepted and Meta then failed.
 *
 * This is the refusal that does NOT arrive in the POST response. The API
 * answers 200 with a message id, and the failure - 131047, the closed 24-hour
 * window, most often - comes back minutes later on the webhook as a delivery
 * status. An alert that was reported sent and then failed never reached the
 * owner, so the email fallback has to fire here too, or the Orders page would
 * be showing a tick for a message nobody received.
 *
 * Returns null when the failed message is not an order alert, or when the
 * fallback has already been sent for it.
 */
export async function alertFailedLater(store, { messageId, error = null }, { env = process.env, outboxDir, smtpConnect } = {}) {
  if (!messageId || typeof store.allOrders !== 'function') return null;
  const orders = await store.allOrders();
  const order = orders.find((o) => o.alert && o.alert.whatsapp && o.alert.whatsapp.messageId === messageId);
  if (!order) return null;
  if (order.alert.email && order.alert.email.sent) return null;

  const text = alertText(order);
  const code = error && error.code !== undefined && error.code !== null ? error.code : null;
  const why =
    code === WINDOW_CLOSED_CODE
      ? `WhatsApp accepted this alert and then failed it: Meta error ${code}, more than 24 hours have passed since the owner last replied to that number.`
      : `WhatsApp accepted this alert and then failed it${code ? `: Meta error ${code}` : ''}${error && error.title ? ` (${error.title})` : ''}.`;
  const email = await deliverAlertEmail({
    subject: `New order ${order.id}`,
    text: `${text}\n\n${why}\n`,
    name: `order-${order.id}-failed`,
    env,
    ...(outboxDir ? { outboxDir } : {}),
    ...(smtpConnect ? { connect: smtpConnect } : {}),
  });

  const alert = {
    ...order.alert,
    whatsapp: {
      ...order.alert.whatsapp,
      sent: false,
      failedLater: true,
      errorCode: code,
      windowClosed: code === WINDOW_CLOSED_CODE,
      reason: why,
    },
    email: { sent: Boolean(email.sent), to: email.sent ? email.to : null, reason: email.reason || null, file: email.file || null },
    channel: email.sent ? 'email' : 'none',
  };
  await store.updateOrder(order.id, { alert });
  await store.appendEvents([
    {
      type: EVENT_ORDER_ALERT,
      at: new Date().toISOString(),
      key: `${order.id}:alert:failed`,
      orderId: order.id,
      channel: alert.channel,
      whatsappSent: false,
      whatsappErrorCode: code,
      emailSent: Boolean(email.sent),
      reason: why,
    },
  ]);
  return { orderId: order.id, channel: alert.channel, emailSent: Boolean(email.sent), errorCode: code };
}

/**
 * The whole loop, in one call.
 *
 * A replay of the same order reference does nothing at all: no second lead
 * note, no second alert, no second event. It returns duplicate:true and the
 * order already stored, which is what the endpoint answers 200 with.
 */
export async function recordOrder(
  store,
  body,
  { env = process.env, fetchImpl, runsDir = RUNS_DIR, date = todayIso(), receivedAt, outboxDir, smtpConnect, notify = true } = {}
) {
  const order = normaliseOrder(body, receivedAt ? { receivedAt } : {});

  const already = await store.getOrder(order.id);
  if (already) {
    return { ok: true, duplicate: true, orderId: order.id, order: already, leadId: already.leadId || null, alert: already.alert || {}, receipt: null };
  }

  const inserted = await store.putOrder(order);
  if (!inserted.inserted) {
    const existing = await store.getOrder(order.id);
    return { ok: true, duplicate: true, orderId: order.id, order: existing, leadId: existing?.leadId || null, alert: existing?.alert || {}, receipt: null };
  }

  const upsert = await upsertOrderLead(store, order);
  const alert = notify ? await alertOwner(order, { env, fetchImpl, outboxDir, smtpConnect }) : { skipped: true, channel: null, whatsapp: null, email: null };
  const stored = (await store.updateOrder(order.id, { leadId: upsert.lead.id, alert })) || { ...order, leadId: upsert.lead.id, alert };

  const at = order.receivedAt;
  const events = [
    {
      type: EVENT_ORDER_RECEIVED,
      at,
      key: order.id,
      orderId: order.id,
      leadId: upsert.lead.id,
      buyer: upsert.lead.name,
      city: order.city || null,
      lines: orderLines(order).length,
      sourcePath: order.sourcePath || null,
    },
    {
      type: EVENT_LEAD_WON,
      at,
      key: `${order.id}:won`,
      orderId: order.id,
      leadId: upsert.lead.id,
      name: upsert.lead.name,
      from: upsert.statusFrom,
      to: 'won',
      created: upsert.created,
      matchedOn: upsert.matchedOn,
    },
  ];
  if (notify) {
    events.push({
      type: EVENT_ORDER_ALERT,
      at: new Date().toISOString(),
      key: `${order.id}:alert`,
      orderId: order.id,
      channel: alert.channel,
      whatsappSent: Boolean(alert.whatsapp?.sent),
      whatsappErrorCode: alert.whatsapp?.errorCode ?? null,
      emailSent: Boolean(alert.email?.sent),
      reason: alert.whatsapp?.reason || null,
    });
  }
  await store.appendEvents(events);

  const sealed = await appendDayBundle(
    `orders_${date}`,
    [
      { type: EVENT_ORDER_RECEIVED, data: { orderId: order.id, leadId: upsert.lead.id, city: order.city || null, lines: orderLines(order).length, created: upsert.created, matchedOn: upsert.matchedOn } },
      { type: EVENT_LEAD_WON, data: { orderId: order.id, leadId: upsert.lead.id, from: upsert.statusFrom, to: 'won' } },
      ...(notify
        ? [{ type: EVENT_ORDER_ALERT, data: { orderId: order.id, channel: alert.channel, whatsapp: alert.whatsapp, email: alert.email } }]
        : []),
    ],
    { runsDir }
  );

  return {
    ok: true,
    duplicate: false,
    orderId: order.id,
    order: stored,
    leadId: upsert.lead.id,
    leadCreated: upsert.created,
    matchedOn: upsert.matchedOn,
    statusFrom: upsert.statusFrom,
    alert,
    receipt: sealed ? sealed.bundle.hash : null,
    receiptFile: sealed ? sealed.file : null,
  };
}

/**
 * A reference for an order the owner takes on the phone. The site issues its own
 * references in its own shape; one the owner records himself is prefixed `OWN-`
 * and carries the date, so the two can never be confused in the register or in
 * the sheet.
 */
export function ownerOrderId(now = new Date(), uuid = randomUUID()) {
  return `OWN-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${uuid.split('-')[0].toUpperCase()}`;
}

/** Rows for the Orders page and the CSV export, newest first. */
export function orderRows(orders) {
  return [...orders]
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .map((o) => ({
      id: o.id,
      date: String(o.createdAt || o.receivedAt || '').slice(0, 10),
      receivedAt: o.receivedAt || null,
      buyer: o.businessName || o.contactName || '(no name)',
      contactName: o.contactName || null,
      phone: o.phone || null,
      email: o.email || null,
      businessType: o.businessType || null,
      city: o.city || null,
      lines: orderLines(o),
      frequency: o.frequency || null,
      volume: o.volume || null,
      neededBy: o.neededBy || null,
      notes: o.notes || null,
      sourcePath: o.sourcePath || null,
      status: o.status || null,
      leadId: o.leadId || null,
      alert: alertLabel(o.alert),
    }));
}

/** One phrase for what became of the owner's alert on this order. */
export function alertLabel(alert) {
  const a = alert || {};
  if (a.skipped) return 'not sent';
  if (a.whatsapp && a.whatsapp.sent) return 'WhatsApp sent';
  if (a.email && a.email.sent) {
    if (a.whatsapp && a.whatsapp.windowClosed) {
      return a.whatsapp.failedLater ? 'email (WhatsApp failed: window closed)' : 'email (WhatsApp window closed)';
    }
    return a.whatsapp && a.whatsapp.failedLater ? 'email (WhatsApp failed after sending)' : 'email (WhatsApp refused)';
  }
  if (a.whatsapp && a.whatsapp.reason) return `not delivered: ${a.whatsapp.reason}`;
  if (a.email && a.email.reason) return `not delivered: ${a.email.reason}`;
  return 'no alert recorded';
}

const CSV_COLUMNS = [
  'id', 'date', 'receivedAt', 'buyer', 'contactName', 'phone', 'email',
  'businessType', 'city', 'lines', 'frequency', 'volume', 'neededBy', 'notes',
  'sourcePath', 'status', 'leadId', 'alert',
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ordersToCsv(orders, columns = CSV_COLUMNS) {
  const rows = orderRows(orders);
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}
