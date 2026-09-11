// Public government registries of produce exporters and processors.
//
// WHAT WAS PROBED, AND WHAT CAME BACK - 2026-09-11, from the machine this was
// written on:
//
//   APEDA (agriexchange.apeda.gov.in/AgriDirectory/Exporter/Exporters)
//     Reachable. No login, no captcha on the directory itself. The listing is
//     rendered server-side and publishes, per exporter: trading name, address,
//     product category, state and PIN. It publishes NO phone and NO email: the
//     "Click here to contact" button leads to a captcha-gated enquiry form that
//     shows the exporter's details to nobody. So this lane produces buyers with
//     an address and no contact, and says so, rather than pretending otherwise.
//     The path in the older APEDA site (apeda.gov.in .../Exporter_Directory.htm)
//     is a 404; agriexchange is where the directory now lives.
//
//   FSSAI licence search (foscos.fssai.gov.in/consumer/fboSearch)
//     Not reachable. Every request, curl and Node alike, timed out at the TCP
//     connect stage - robots.txt included, so we never learned whether we would
//     have been allowed to read it. Recorded as blocked, not as empty.
//
// An exporter or processor is a buyer for a produce supplier: peeled and cut
// vegetables are exactly what a processing unit buys in. The lane is therefore
// worth having even without a phone number on the listing - the register keeps
// the address and the owner can place the call himself.

import { EXPORTERS, USER_AGENT } from '../config.mjs';
import { createCrawler, describeFetchError } from '../lib/crawl.mjs';
import { robotsAllows } from '../llm/page.mjs';
import { decodeEntities, stripTags } from '../lib/xml.mjs';
import { tidy, isExcluded } from '../lib/normalise.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'exporters';

export const APEDA_LISTING = 'https://agriexchange.apeda.gov.in/AgriDirectory/Exporter/Exporters';

/** The letters of the alphabet the directory is paged by, in the order we ask. */
export const APEDA_LETTERS = ['A', 'B', 'C'];

export function apedaBody(letter) {
  return new URLSearchParams({ charVal: letter, expName: '', expState: '', expType: '', selectedLetter: letter }).toString();
}

const CARD_RE = /<div class="box col-md-4">([\s\S]*?)<\/div>\s*<\/div>/gi;
const P_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;

/**
 * Read the directory's cards.
 *
 * Each card is five paragraphs in a fixed order - name, address, product, state,
 * PIN - and a contact button. The parser reads them positionally and drops a
 * card that does not have at least a name and an address, because a half-read
 * card is a lead with a wrong address on it.
 */
export function parseApedaListing(html, { letter = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const card of String(html).matchAll(CARD_RE)) {
    const parts = [];
    for (const p of card[1].matchAll(P_RE)) {
      const text = stripTags(p[1]);
      if (text) parts.push(text);
    }
    if (parts.length < 2) continue;
    const [rawName, address, product = null, state = null, pin = null] = parts;
    const name = tidy(decodeEntities(rawName), 160);
    if (!name || isExcluded(name)) continue;
    const certificate = (card[1].match(/sendData\('([^']+)'\)/) || [])[1] || null;
    const key = `${name}|${state || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      address: tidy(address, 240),
      product: product ? tidy(product, 120) : null,
      state: state ? tidy(state, 80) : null,
      pin: pin && /^\d{6}$/.test(String(pin).trim()) ? String(pin).trim() : null,
      certificate,
      letter,
    });
  }
  return out;
}

/**
 * A directory row as a buyer candidate.
 *
 * `food_manufacturer` because that is what a registered produce exporter is to
 * a supplier: a unit that buys cleaned, peeled and cut produce in volume. The
 * candidate carries no phone and no email, and records the reason, so nothing
 * downstream mistakes an empty field for one we failed to read.
 */
export function buildCandidate(row) {
  return {
    kind: 'buyer',
    segment: 'food_manufacturer',
    name: row.name,
    city: null,
    state: row.state,
    address: row.address,
    phone: null,
    email: null,
    website: null,
    whyNow: 'listed in the APEDA registered exporter directory',
    whyNowDate: null,
    source: 'exporters',
    sourceUrl: APEDA_LISTING,
    licence: EXPORTERS.licence,
    externalId: `apeda_${sha256Hex(`${row.certificate || ''}|${row.name}|${row.state || ''}`).slice(0, 20)}`,
    extra: {
      registry: 'APEDA registered exporters',
      product: row.product,
      pin: row.pin,
      certificate: row.certificate,
      letter: row.letter,
      contactComplete: false,
      contactNotFound:
        'APEDA publishes no phone or email for a registered exporter - the directory\'s contact button opens a captcha-gated enquiry form',
    },
  };
}

export async function fetch(ctx = {}) {
  const log = ctx.log || (() => {});
  const crawler =
    ctx.crawler ||
    createCrawler({
      fetchImpl: ctx.fetchImpl || globalThis.fetch,
      perHostPauseMs: EXPORTERS.pauseMs,
      timeoutMs: EXPORTERS.httpTimeoutMs,
    });
  const post = ctx.post || defaultPost;

  const probes = [];
  const candidates = [];

  // ---------------------------------------------------------------- APEDA
  for (const letter of ctx.letters || APEDA_LETTERS) {
    const res = await post(APEDA_LISTING, apedaBody(letter), { crawler, timeoutMs: EXPORTERS.httpTimeoutMs });
    probes.push({ registry: 'apeda', letter, url: APEDA_LISTING, ok: Boolean(res.ok), status: res.status ?? null, reason: res.ok ? null : res.reason, bytes: res.bytes ?? null });
    if (!res.ok) {
      log(`exporters: APEDA letter ${letter} -> ${res.reason}`);
      continue;
    }
    const rows = parseApedaListing(res.html, { letter });
    log(`exporters: APEDA letter ${letter} -> ${rows.length} listed exporters`);
    for (const row of rows) candidates.push(buildCandidate(row));
  }

  // ---------------------------------------------------------------- FSSAI
  const fssai = await crawler.fetchDoc(EXPORTERS.fssai.urls[0]);
  probes.push({ registry: 'fssai', url: EXPORTERS.fssai.urls[0], ok: Boolean(fssai.ok), status: fssai.status ?? null, reason: fssai.ok ? null : fssai.reason });

  const apedaOk = probes.some((p) => p.registry === 'apeda' && p.ok);
  const deduped = dedupe(candidates);
  const detail = {
    probes,
    apeda: {
      name: EXPORTERS.apeda.name,
      reachable: apedaOk,
      listed: deduped.length,
      publishesContacts: false,
      note: 'the directory publishes name, address, product category, state and PIN; the contact button opens a captcha-gated enquiry form, so no phone or email is available to read',
    },
    fssai: {
      name: EXPORTERS.fssai.name,
      reachable: Boolean(fssai.ok),
      reason: fssai.ok ? null : fssai.reason,
    },
  };

  const blockedNotes = [];
  if (!apedaOk) blockedNotes.push(`APEDA: ${probes.find((p) => p.registry === 'apeda' && !p.ok)?.reason || 'no response'}`);
  if (!fssai.ok) blockedNotes.push(`FSSAI: ${fssai.reason}`);

  return {
    candidates: deduped,
    detail,
    blocked: blockedNotes.length
      ? {
          source: 'exporters',
          kind: apedaOk ? 'partial' : 'no-open-registry',
          reason: blockedNotes.join(' | '),
        }
      : null,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    if (seen.has(c.externalId)) return false;
    seen.add(c.externalId);
    return true;
  });
}

/**
 * The directory is a form POST, and the shared crawler is a GET fetcher, so this
 * is the one place the demand lane posts. It still goes through the crawler's
 * robots check first, so the rule is applied even though the request is not.
 */
async function defaultPost(url, body, { crawler, timeoutMs }) {
  const target = new URL(url);
  const robots = await crawler.robotsFor(target.origin);
  if (!robotsAllows(robots, target.pathname)) {
    return { ok: false, reason: `robots.txt disallows ${target.pathname}` };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method: 'POST',
      body,
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });
    const html = await res.text();
    return res.ok
      ? { ok: true, html, status: res.status, bytes: Buffer.byteLength(html) }
      : { ok: false, reason: `HTTP ${res.status}`, status: res.status };
  } catch (err) {
    return { ok: false, reason: describeFetchError(err) };
  } finally {
    clearTimeout(timer);
  }
}
