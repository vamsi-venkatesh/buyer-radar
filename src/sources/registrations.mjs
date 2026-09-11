// Where a new supplier can put his name down.
//
// This lane answers a different question from the others. It is not "who needs
// vegetables today"; it is "which buyers accept a new supplier at all, and what
// do they ask him to do". That does not change overnight, so it is emitted once
// a week, on Mondays, rather than every morning - a section the owner sees daily
// and can never act on differently is a section he stops reading.
//
// Each page is fetched to confirm it is still live and to record when we last
// looked. A contact is written down only when the page itself publishes one.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { REGISTRATIONS } from '../config.mjs';
import { createCrawler, mapPool } from '../lib/crawl.mjs';
import { extractContacts } from '../lib/contacts.mjs';
import { tidy, todayIso } from '../lib/normalise.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'registrations';

/** What kind of buyer this is, in the segments the rest of the pipeline uses. */
export const SEGMENT_BY_TYPE = {
  quick_commerce: 'retailer',
  fresh_grocery: 'retailer',
  modern_trade: 'retailer',
  cash_and_carry: 'wholesale',
  agri_b2b: 'distributor',
  hotel_group: 'hotel',
  caterer: 'caterer',
};

export async function loadRegistry(file = path.join(ROOT, REGISTRATIONS.registry)) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  return entries.filter((e) => e && e.name && e.url);
}

/** Mondays only. Returns the reason when it is not due, so the run can record it. */
export function isDue(dateIso, { weekday = REGISTRATIONS.weekday } = {}) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { due: false, reason: `unreadable date ${dateIso}` };
  const day = d.getUTCDay();
  if (day === weekday) return { due: true, reason: null };
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { due: false, reason: `not due: the registration list is weekly, on ${names[weekday]}, and ${dateIso} is a ${names[day]}` };
}

export function buildCandidate({ entry, check, checkedAt }) {
  const contacts = check && check.ok && check.text ? extractContacts(check.text) : null;
  // The registry never carries an invented contact. Anything here came either
  // from the page we just read, or from a value the registry author could point
  // at on that page.
  const phone = (contacts && contacts.phone) || null;
  const email = (contacts && contacts.email) || (entry.contact && /@/.test(entry.contact) ? entry.contact : null);
  return {
    kind: 'registration',
    segment: SEGMENT_BY_TYPE[entry.type] || 'distributor',
    name: entry.name,
    city: entry.city || null,
    state: null,
    address: null,
    phone,
    email,
    website: entry.url,
    whyNow: check && check.ok ? 'supplier registration page is live' : 'supplier registration page did not answer',
    whyNowDate: null,
    requirement: tidy(entry.buys, 200),
    quantity: null,
    deadline: null,
    contact_name: (contacts && contacts.name) || null,
    contact_phone: phone,
    contact_email: email,
    document_url: entry.url,
    source: 'registrations',
    sourceUrl: entry.url,
    licence: REGISTRATIONS.licence,
    externalId: `reg_${sha256Hex(entry.url).slice(0, 20)}`,
    extra: {
      organisation: entry.name,
      buyerType: entry.type || null,
      how: tidy(entry.how, 200),
      live: Boolean(check && check.ok),
      status: check ? check.status ?? null : null,
      checkReason: check && !check.ok ? check.reason : null,
      lastChecked: checkedAt,
      contactComplete: Boolean(phone || email),
      contactFromPage: Boolean(contacts && (contacts.phone || contacts.email)),
    },
  };
}

export async function fetch(ctx = {}) {
  const today = ctx.todayIsoDate || todayIso();
  const due = isDue(today);
  const registry = ctx.registry || (await loadRegistry());
  const log = ctx.log || (() => {});

  if (!due.due && !ctx.force) {
    log(`registrations: ${due.reason}`);
    return { candidates: [], detail: { due: false, reason: due.reason, entries: registry.length, weekday: REGISTRATIONS.weekday } };
  }

  const crawler =
    ctx.crawler ||
    createCrawler({
      fetchImpl: ctx.fetchImpl || globalThis.fetch,
      perHostPauseMs: REGISTRATIONS.pauseMs,
      timeoutMs: REGISTRATIONS.httpTimeoutMs,
    });

  const checkedAt = new Date().toISOString();
  const candidates = await mapPool(registry, ctx.concurrency || 6, async (entry) => {
    const check = await crawler.fetchDoc(entry.url);
    return buildCandidate({ entry, check, checkedAt });
  });

  const live = candidates.filter((c) => c.extra.live).length;
  const withContact = candidates.filter((c) => c.contact_phone || c.contact_email).length;
  log(`registrations: ${registry.length} pages checked, ${live} live, ${withContact} publish a contact`);

  return {
    candidates,
    detail: {
      due: true,
      entries: registry.length,
      live,
      dead: registry.length - live,
      withContact,
      checkedAt,
      crawler: crawler.stats(),
      pages: candidates.map((c) => ({ name: c.name, url: c.sourceUrl, live: c.extra.live, status: c.extra.status, reason: c.extra.checkReason })),
    },
  };
}
