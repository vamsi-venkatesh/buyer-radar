import { request, sleep } from '../lib/http.mjs';
import { AGMARKNET } from '../config.mjs';
import { tidy } from '../lib/normalise.mjs';

export const name = 'agmarknet';

/**
 * Daily mandi prices from data.gov.in resource 9ef84268-d588-465a-a308-a864a43d0070.
 * Requires a free API key in DATA_GOV_IN_KEY. Without the key the source is
 * skipped with a recorded reason. Prices are never invented.
 */

export function buildUrl(apiKey, { commodity, state, limit = AGMARKNET.limit }) {
  const u = new URL(AGMARKNET.endpoint);
  u.searchParams.set('api-key', apiKey);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('filters[commodity]', commodity);
  u.searchParams.set('filters[state]', state);
  return u.toString();
}

/** Redact the api key so it never reaches a receipt, a log line or a file. */
export function redact(url) {
  return String(url).replace(/([?&]api-key=)[^&]*/i, '$1REDACTED');
}

export function parseRecords(body, { commodity, state, sourceUrl }) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  const out = [];
  for (const r of data.records || []) {
    const date = toIso(r.arrival_date);
    out.push({
      kind: 'price',
      segment: 'other',
      name: tidy(`${r.commodity || commodity} - ${r.market || 'market'}`, 160),
      city: r.district || null,
      state: r.state || state,
      address: [r.market, r.district, r.state].filter(Boolean).join(', ') || null,
      phone: null,
      email: null,
      website: null,
      whyNow: date ? `mandi price ${date}` : 'mandi price',
      whyNowDate: date,
      source: 'agmarknet',
      sourceUrl,
      licence: AGMARKNET.licence,
      externalId: [r.state, r.district, r.market, r.commodity, r.variety, r.arrival_date]
        .filter(Boolean)
        .join('|'),
      extra: {
        commodity: r.commodity || commodity,
        variety: r.variety || null,
        market: r.market || null,
        minPrice: numberOrNull(r.min_price),
        maxPrice: numberOrNull(r.max_price),
        modalPrice: numberOrNull(r.modal_price),
        unit: 'INR per quintal',
        arrivalDate: r.arrival_date || null,
      },
    });
  }
  return out;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(ddmmyyyy) {
  const m = String(ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export async function fetch(ctx) {
  const { city, log } = ctx;
  const apiKey = process.env.DATA_GOV_IN_KEY;
  if (!apiKey) {
    const reason = 'DATA_GOV_IN_KEY not set';
    log(`agmarknet: skipped - ${reason}`);
    return { candidates: [], blocked: { source: 'agmarknet', reason, kind: 'no-key' } };
  }

  const states = city?.agmarknetState ? [city.agmarknetState] : AGMARKNET.states;
  const all = [];
  const detail = {};
  let first = true;

  for (const state of states) {
    for (const commodity of AGMARKNET.commodities) {
      if (!first) await sleep(AGMARKNET.pauseMs);
      first = false;
      const url = buildUrl(apiKey, { commodity, state });
      const res = await request(url, { timeoutMs: AGMARKNET.httpTimeoutMs });
      const safeUrl = redact(url);
      if (!res.ok) {
        const reason = `HTTP ${res.status} from data.gov.in for ${commodity}/${state}`;
        log(`agmarknet: BLOCKED ${reason}`);
        return { candidates: all, blocked: { source: 'agmarknet', reason, status: res.status }, detail };
      }
      const parsed = parseRecords(res.text, { commodity, state, sourceUrl: safeUrl });
      detail[`${commodity}/${state}`] = { records: parsed.length, ms: res.ms };
      all.push(...parsed);
      log(`agmarknet: ${commodity}/${state} records=${parsed.length}`);
    }
  }

  return { candidates: all, detail };
}
