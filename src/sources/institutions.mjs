// Institutional buyers who have posted a requirement.
//
// This is the demand lane. A directory tells the owner that a hospital exists;
// this tells him that the hospital has published a notice for vegetable supply,
// how much it wants, by when, and - where the notice names one - who to ring.
//
// The registry in config/institutional-buyers.json is hand-written and is a list
// of places to look, not a list of leads. Every entry was probed once for real;
// what answered is in config/institutional-buyers.probe.json, and an entry that
// answered nothing is skipped rather than fetched again every morning.
//
// Nothing here invents a contact, a quantity or a date. A notice that states
// none yields a candidate that says so.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import { INSTITUTIONS } from '../config.mjs';
import { createCrawler, mapPool } from '../lib/crawl.mjs';
import { parseLinks, parseTableRows, stripTags } from '../lib/xml.mjs';
import { extractContacts } from '../lib/contacts.mjs';
import { bestQuantity, mentionsHeadlineCommodity, quantityFit } from '../lib/quantity.mjs';
import { findDeadline } from '../lib/dates.mjs';
import { tidy, todayIso, isExcluded } from '../lib/normalise.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'institutions';

// ------------------------------------------------------------------ registry

export async function loadRegistry(file = path.join(ROOT, INSTITUTIONS.registry)) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  return entries.filter((e) => e && e.name && e.domain && Array.isArray(e.tender_paths) && e.tender_paths.length);
}

export async function loadProbe(file = path.join(ROOT, INSTITUTIONS.probeFile)) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * An entry the probe found unreachable on every one of its paths is not fetched
 * again on a daily run. It stays in the registry, marked, so the gap is visible
 * rather than quietly deleted - and re-running the probe is what un-marks it.
 */
export function skipFromProbe(entry, probe) {
  if (!probe || !Array.isArray(probe.entries)) return null;
  const record = probe.entries.find((r) => r.name === entry.name);
  if (!record) return null;
  if (record.reachable === false) return record.reason || 'probe found no reachable tender page';
  return null;
}

// ------------------------------------------------------------------ matching

// Longest first. Alternation takes the first branch that matches, so with
// "vegetable" ahead of "vegetables" every plural notice would report the
// singular - a small lie in the receipts about what the crawler actually saw.
//
// Anchored on word boundaries, and that is not a nicety. Without them "mess"
// matched inside "message", and the first real digest this lane produced led
// with three notices called "Director's message" and "Commissioner's Message".
// A keyword has to be a word.
const KEYWORD_RE = new RegExp(
  `\\b(${[...INSTITUTIONS.keywords]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|')})\\b`,
  'i'
);

/** The keyword that makes a notice title worth opening, or null. */
export function matchedKeyword(text) {
  const m = KEYWORD_RE.exec(String(text || ''));
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
}

const SKIP_HREF = /^(?:mailto:|tel:|javascript:|#)/i;

function absolute(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The notice links on a tender listing page whose title matches a keyword.
 *
 * Two shapes, because these pages come in two shapes. Most carry the notice
 * title as the anchor text. Many carry it in a table cell with a bare
 * "Download" or a PDF icon as the only link in the row, and reading only the
 * anchor text would miss every one of those - so a row whose *text* matches
 * lends its text to the links inside it.
 */
export function extractNoticeLinks(html, pageUrl) {
  const found = new Map();
  const add = (href, title, keyword, via) => {
    const url = absolute(href, pageUrl);
    if (!url || SKIP_HREF.test(href)) return;
    if (url.split('#')[0] === String(pageUrl).split('#')[0]) return;
    const clean = tidy(title, 200);
    if (!clean || isExcluded(clean)) return;
    const existing = found.get(url);
    if (existing && existing.title.length >= clean.length) return;
    found.set(url, { url, title: clean, keyword, via });
  };

  for (const link of parseLinks(html)) {
    const keyword = matchedKeyword(`${link.text} ${link.href}`);
    if (keyword) add(link.href, link.text || link.href, keyword, 'anchor');
  }

  for (const m of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = m[1];
    const rowText = stripTags(rowHtml);
    const keyword = matchedKeyword(rowText);
    if (!keyword) continue;
    for (const link of parseLinks(rowHtml)) {
      if (SKIP_HREF.test(link.href)) continue;
      add(link.href, rowText, keyword, 'table row');
    }
  }

  return [...found.values()];
}

/** Rows on a listing page that match but carry no link at all, so nothing to follow. */
export function unlinkedMatches(html) {
  const out = [];
  for (const cells of parseTableRows(html)) {
    const text = cells.join(' ');
    const keyword = matchedKeyword(text);
    if (keyword && !/<a\b/i.test(text)) out.push({ title: tidy(text, 200), keyword });
  }
  return out;
}

// ---------------------------------------------------------------- candidates

/** Stable id for a notice: the document URL, which is what identifies it. */
export function noticeId(url) {
  return `inst_${sha256Hex(String(url)).slice(0, 24)}`;
}

/**
 * Build one requirement candidate from a notice that was actually read.
 *
 * `text` is what the notice said - HTML text or PDF text. When the document was
 * a PDF we could not read, `text` is empty and `unreadable` is the reason; the
 * candidate is still emitted, because "this body posted a vegetable supply
 * notice today and the PDF is a scan" is worth the owner's time, but it carries
 * no quantity, no deadline and no contact, and the digest says so.
 */
export function buildCandidate({ entry, notice, text = '', unreadable = null, todayIsoDate = todayIso() }) {
  const body = String(text || '');
  const haystack = `${notice.title}\n${body}`;
  const contacts = body ? extractContacts(body) : { phone: null, email: null, name: null, complete: false };
  const closing = body ? findDeadline(body, { todayIsoDate }) : null;
  const quantity = bestQuantity(haystack);
  const headline = mentionsHeadlineCommodity(haystack);
  const fit = quantityFit(quantity, { headline });

  const deadline = closing ? closing.deadline : null;
  return {
    kind: 'requirement',
    segment: 'institution',
    name: entry.name,
    city: entry.city || null,
    state: entry.state || null,
    address: null,
    phone: contacts.phone,
    email: contacts.email,
    website: entry.domain,
    whyNow: deadline ? `requirement posted, closes ${deadline}` : 'requirement posted',
    whyNowDate: deadline,
    // The fields the demand lane is judged on, carried flat on the candidate and
    // folded into the lead's extra under these exact names.
    requirement: tidy(notice.title, 200),
    quantity: quantity ? quantity.phrase : null,
    deadline,
    contact_name: contacts.name,
    contact_phone: contacts.phone,
    contact_email: contacts.email,
    document_url: notice.url,
    source: 'institutions',
    sourceUrl: notice.url,
    licence: INSTITUTIONS.licence,
    externalId: noticeId(notice.url),
    extra: {
      organisation: entry.name,
      category: entry.category || null,
      listingUrl: notice.listingUrl || null,
      matchedKeyword: notice.keyword || null,
      foundVia: notice.via || null,
      quantityKg: quantity ? quantity.kg : null,
      quantityKgPerDay: quantity ? quantity.kgPerDay : null,
      quantityFit: fit,
      mentionsHeadline: headline,
      deadlineFrom: closing ? closing.from : null,
      contactComplete: contacts.complete,
      contactNameKind: contacts.nameKind || null,
      unreadable: unreadable || null,
      // Kept for the model stage, which reads it rather than re-fetching.
      noticeText: body ? body.slice(0, INSTITUTIONS.maxNoticeTextChars) : null,
      noticeChars: body.length,
    },
  };
}

// -------------------------------------------------------------------- crawl

/**
 * One registry entry: read its listing pages, follow the notices that match.
 * Returns everything the probe file records plus the candidates, so the probe
 * tool and the daily run take exactly the same path through the same code.
 */
export async function fetchEntry(entry, { crawler, maxNotices = INSTITUTIONS.maxNoticesPerEntry, todayIsoDate = todayIso(), log = () => {} }) {
  const record = {
    name: entry.name,
    city: entry.city || null,
    state: entry.state || null,
    domain: entry.domain,
    category: entry.category || null,
    reachable: false,
    pages: [],
    notice_links_found: 0,
    notices_read: 0,
    notices_unreadable: 0,
    contacts_found: 0,
    reason: null,
  };
  const candidates = [];
  const links = new Map();

  for (const pageUrl of entry.tender_paths) {
    const res = await crawler.fetchDoc(pageUrl);
    const page = { url: pageUrl, ok: Boolean(res.ok), status: res.status ?? null, reason: res.ok ? null : res.reason, matches: 0 };
    if (res.ok) {
      record.reachable = true;
      const html = res.kind === 'html' ? res.html : null;
      const found = html ? extractNoticeLinks(html, res.url || pageUrl) : [];
      for (const l of found) if (!links.has(l.url)) links.set(l.url, { ...l, listingUrl: res.url || pageUrl });
      page.matches = found.length;
      page.unlinked = html ? unlinkedMatches(html).length : 0;
      page.kind = res.kind;
      page.bytes = res.bytes ?? null;
    }
    record.pages.push(page);
  }

  record.notice_links_found = links.size;
  if (!record.reachable) {
    record.reason = record.pages.map((p) => `${p.url}: ${p.reason}`).join(' | ') || 'no tender path answered';
    return { record, candidates };
  }

  for (const notice of [...links.values()].slice(0, maxNotices)) {
    const doc = await crawler.fetchDoc(notice.url);
    if (doc.ok) {
      record.notices_read += 1;
      const c = buildCandidate({ entry, notice, text: doc.text, todayIsoDate });
      if (c.contact_phone || c.contact_email) record.contacts_found += 1;
      candidates.push(c);
      continue;
    }
    if (doc.reason === 'unreadable') {
      record.notices_unreadable += 1;
      candidates.push(
        buildCandidate({ entry, notice, text: '', unreadable: doc.detail || 'the document could not be read as text', todayIsoDate })
      );
      continue;
    }
    log(`institutions: ${entry.name} notice ${notice.url} -> ${doc.reason}`);
  }

  return { record, candidates };
}

export async function fetch(ctx = {}) {
  const { log = () => {} } = ctx;
  const todayIsoDate = ctx.todayIsoDate || todayIso();
  const registry = ctx.registry || (await loadRegistry());
  const probe = ctx.probe !== undefined ? ctx.probe : await loadProbe();
  const crawler =
    ctx.crawler ||
    createCrawler({
      fetchImpl: ctx.fetchImpl || globalThis.fetch,
      perHostPauseMs: INSTITUTIONS.pauseMs,
      maxBytes: INSTITUTIONS.maxBytes,
      maxTextChars: INSTITUTIONS.maxNoticeTextChars,
      timeoutMs: INSTITUTIONS.httpTimeoutMs,
    });

  const skipped = [];
  const live = registry.filter((entry) => {
    const reason = skipFromProbe(entry, probe);
    if (reason) {
      skipped.push({ name: entry.name, reason });
      return false;
    }
    return true;
  });

  const results = await mapPool(live, ctx.concurrency || INSTITUTIONS.concurrency, (entry) =>
    fetchEntry(entry, { crawler, todayIsoDate, log })
  );

  const candidates = results.flatMap((r) => r.candidates);
  const records = results.map((r) => r.record);
  const reachable = records.filter((r) => r.reachable).length;
  const withNotices = records.filter((r) => r.notice_links_found > 0).length;
  const withContacts = candidates.filter((c) => c.contact_phone || c.contact_email).length;

  log(
    `institutions: ${live.length} probed, ${reachable} reachable, ${withNotices} with matching notices, ` +
      `${candidates.length} requirements, ${withContacts} with a contact`
  );

  const detail = {
    registryEntries: registry.length,
    skipped: skipped.length,
    skippedNames: skipped.map((s) => s.name),
    probed: live.length,
    reachable,
    withMatchingNotices: withNotices,
    requirements: candidates.length,
    withContact: withContacts,
    unreadable: records.reduce((n, r) => n + r.notices_unreadable, 0),
    crawler: crawler.stats(),
    records,
  };

  if (!reachable && live.length) {
    return {
      candidates,
      detail,
      blocked: {
        source: 'institutions',
        kind: 'no-open-listing',
        reason: `none of the ${live.length} probed tender pages answered - every one returned an error, a redirect we could not follow, or a page with no readable text`,
      },
    };
  }
  return { candidates, detail };
}
