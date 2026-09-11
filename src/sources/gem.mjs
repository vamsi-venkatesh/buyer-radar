// Government e Marketplace public bid search.
//
// HONESTY NOTE, and it is the whole reason this file is shaped the way it is:
// this source has never seen a response. On 2026-09-11, from the machine this
// was written on, every request to the GeM estate - bidplus.gem.gov.in/robots.txt,
// /all-bids, and gem.gov.in itself - timed out at the TCP connect stage. DNS
// resolves (160.187.232.18); nothing answers. curl and Node's fetch agree, so it
// is the network path and not our client.
//
// Therefore:
//   * the source is OFF unless GEM_ENABLED=true, and a run with it off records
//     `source.blocked` with that exact reason rather than an empty result;
//   * `parseBids()` is written against a response shape this project has
//     DOCUMENTED AS ASSUMED (see README, "GeM"), not against one it has read;
//   * a body that does not match that shape is reported as an unrecognised
//     shape. It is never coerced, never guessed at, and never turned into a
//     candidate. A wrong lead is worse than no lead.

import { GEM } from '../config.mjs';
import { request, sleep } from '../lib/http.mjs';
import { tidy, todayIso } from '../lib/normalise.mjs';
import { bestQuantity, mentionsHeadlineCommodity, quantityFit } from '../lib/quantity.mjs';
import { parseIndianDate } from '../lib/dates.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'gem';

export function listUrl() {
  return `${GEM.base}${GEM.listPath}`;
}

export function dataUrl() {
  return `${GEM.base}${GEM.dataPath}`;
}

/**
 * The POST body the public search form sends, as documented in the README.
 * `payload` is the JSON the page's own script posts; `csrf_bd_gem_nk` is the
 * token the page carries. Both are sent as form fields.
 */
export function searchBody({ keyword, page = 1, csrf = null, pageSize = GEM.pageSize }) {
  const payload = JSON.stringify({
    page,
    param: { searchBid: keyword, searchType: 'fullText' },
    filter: { bidStatusType: 'ongoing_bids', byType: 'all', highBidValue: '', byEndDate: { from: '', to: '' }, sort: 'Bid-End-Date-Latest' },
    size: pageSize,
  });
  const form = new URLSearchParams({ payload });
  if (csrf) form.set('csrf_bd_gem_nk', csrf);
  return form.toString();
}

/** The CSRF token the search page carries, or null if the page does not show one. */
export function readCsrf(html) {
  const m = /name="csrf_bd_gem_nk"\s+value="([^"]+)"/i.exec(String(html || '')) ||
    /csrf_bd_gem_nk"\s*:\s*"([^"]+)"/i.exec(String(html || ''));
  return m ? m[1] : null;
}

function isoFrom(raw) {
  const s = String(raw || '');
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  return parseIndianDate(s.split(/[ T]/)[0]);
}

/**
 * Read the documented assumed response shape into candidates.
 *
 * The shape: `{ response: { response: { docs: [...], numFound } } }`, each doc
 * carrying `b_bid_number`, `b_category_name`, `b_total_quantity`,
 * `b_bid_end_date_sort` and `ba_official_details_deptName`. Anything else comes
 * back as `{ ok: false, reason: 'unrecognised shape' }`.
 */
export function parseBids(body, { keyword = null, todayIsoDate = todayIso() } = {}) {
  let json = body;
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'unrecognised shape: the body is not JSON', candidates: [] };
    }
  }
  const docs = json?.response?.response?.docs;
  if (!Array.isArray(docs)) {
    return { ok: false, reason: 'unrecognised shape: no response.response.docs array', candidates: [] };
  }

  const candidates = [];
  for (const doc of docs) {
    const bidNumber = typeof doc?.b_bid_number === 'string' ? doc.b_bid_number : null;
    const category = typeof doc?.b_category_name === 'string' ? doc.b_category_name : null;
    if (!bidNumber || !category) continue;
    const department = first(doc?.ba_official_details_deptName) || first(doc?.ba_official_details_minName) || null;
    const office = first(doc?.ba_official_details_officeZone) || null;
    const deadline = isoFrom(doc?.b_bid_end_date_sort);
    const qtyRaw = doc?.b_total_quantity;
    const quantityText = Number.isFinite(Number(qtyRaw)) && Number(qtyRaw) > 0 ? `${Number(qtyRaw)} ${doc?.b_unit || 'units'}` : null;
    const quantity = quantityText ? bestQuantity(quantityText) : null;
    const headline = mentionsHeadlineCommodity(category);

    candidates.push({
      kind: 'requirement',
      segment: 'institution',
      name: tidy(department || office || 'Government e Marketplace buyer', 160),
      city: office ? tidy(office, 80) : null,
      state: null,
      address: null,
      phone: null,
      email: null,
      website: GEM.base,
      whyNow: deadline ? `bid closes ${deadline}` : 'open bid on GeM',
      whyNowDate: deadline,
      requirement: tidy(category, 200),
      quantity: quantityText,
      deadline,
      // GeM does not publish a buyer's phone or email on the public listing, so
      // this lane never carries one. The bid document is the contact route.
      contact_name: null,
      contact_phone: null,
      contact_email: null,
      document_url: `${GEM.base}/showbidDocument/${encodeURIComponent(bidNumber)}`,
      source: 'gem',
      sourceUrl: listUrl(),
      licence: GEM.licence,
      externalId: `gem_${sha256Hex(bidNumber).slice(0, 20)}`,
      extra: {
        bidNumber,
        organisation: department || office || null,
        keyword,
        quantityKg: quantity ? quantity.kg : null,
        quantityKgPerDay: quantity ? quantity.kgPerDay : null,
        quantityFit: quantityFit(quantity, { headline }),
        mentionsHeadline: headline,
        contactComplete: false,
        contactNotFound: 'GeM does not publish the buyer\'s phone or email on the public bid listing',
        shape: 'assumed',
        todayIsoDate,
      },
    });
  }
  return { ok: true, candidates, numFound: json?.response?.response?.numFound ?? docs.length };
}

function first(v) {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

export function enabled(env = process.env) {
  return String(env[GEM.enabledEnv]).toLowerCase() === 'true';
}

export async function fetch(ctx = {}) {
  const env = ctx.env || process.env;
  const log = ctx.log || (() => {});
  const todayIsoDate = ctx.todayIsoDate || todayIso();

  if (!enabled(env)) {
    const reason =
      `${GEM.enabledEnv} is not true - the GeM lane is off by default because every request to the GeM ` +
      'estate from the machine this was built on timed out at the TCP connect stage on 2026-09-11, so its ' +
      'response shape is documented as assumed and has never been read';
    log(`gem: BLOCKED ${reason}`);
    return { candidates: [], blocked: { source: 'gem', kind: 'disabled', reason }, detail: { enabled: false } };
  }

  const req = ctx.request || request;
  const probes = [];

  // The search page first, for its CSRF token. Its absence is not fatal - the
  // endpoint may not require one - but it is recorded either way.
  let csrf = null;
  try {
    const page = await req(listUrl(), { timeoutMs: GEM.httpTimeoutMs });
    probes.push({ url: listUrl(), status: page.status, bytes: page.text.length, ms: page.ms });
    if (page.ok) csrf = readCsrf(page.text);
  } catch (err) {
    const reason = `${err.name}: ${err.message} from ${listUrl()}`;
    log(`gem: BLOCKED ${reason}`);
    return { candidates: [], blocked: { source: 'gem', kind: 'error', reason }, detail: { probes } };
  }

  const all = [];
  const shapes = [];
  let first_ = true;
  for (const keyword of GEM.keywords) {
    if (!first_) await sleep(GEM.pauseMs);
    first_ = false;
    let res;
    try {
      res = await req(dataUrl(), {
        method: 'POST',
        body: searchBody({ keyword, csrf }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        timeoutMs: GEM.httpTimeoutMs,
      });
    } catch (err) {
      const reason = `${err.name}: ${err.message} from ${dataUrl()}`;
      log(`gem: BLOCKED ${reason}`);
      return { candidates: all, blocked: { source: 'gem', kind: 'error', reason }, detail: { probes, shapes } };
    }
    probes.push({ url: dataUrl(), keyword, status: res.status, bytes: res.text.length, ms: res.ms });
    if (!res.ok) {
      const reason = `HTTP ${res.status} from ${dataUrl()} for keyword ${JSON.stringify(keyword)}`;
      log(`gem: BLOCKED ${reason}`);
      return { candidates: all, blocked: { source: 'gem', kind: 'http', status: res.status, reason }, detail: { probes, shapes } };
    }
    const parsed = parseBids(res.text, { keyword, todayIsoDate });
    shapes.push({ keyword, ok: parsed.ok, reason: parsed.reason || null, found: parsed.candidates.length });
    if (!parsed.ok) {
      const reason =
        `${parsed.reason} - the GeM response shape this client parses is documented as assumed in the README ` +
        'and has never been observed; nothing was read from this body rather than guessed at';
      log(`gem: BLOCKED ${reason}`);
      return { candidates: all, blocked: { source: 'gem', kind: 'unrecognised-shape', reason }, detail: { probes, shapes } };
    }
    all.push(...parsed.candidates);
  }

  return { candidates: dedupe(all), detail: { enabled: true, probes, shapes, csrf: Boolean(csrf) } };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    if (seen.has(c.externalId)) return false;
    seen.add(c.externalId);
    return true;
  });
}
