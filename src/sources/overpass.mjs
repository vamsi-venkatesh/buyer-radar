import { request, sleep } from '../lib/http.mjs';
import { OVERPASS, OVERPASS_GROUPS } from '../config.mjs';
import { segmentFromOsmTags, osmAddress, isExcluded, tidy } from '../lib/normalise.mjs';

export const name = 'overpass';

/** Build one Overpass QL query for a group of tag selectors over a bbox. */
export function buildQuery(group, bbox, timeout = OVERPASS.timeout) {
  const box = bbox.join(',');
  const body = group.selectors
    .map(([k, v]) => `  nwr["${k}"="${v}"](${box});`)
    .join('\n');
  return `[out:json][timeout:${timeout}];\n(\n${body}\n);\nout center tags;`;
}

/** Turn an Overpass element into a Candidate, or null when it is not usable. */
export function elementToCandidate(el, city) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'] || tags.operator || tags.brand;
  if (!name) return null;
  const haystack = `${name} ${tags.cuisine || ''} ${tags.description || ''} ${tags.operator || ''}`;
  if (isExcluded(haystack)) return null;

  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;

  return {
    kind: 'buyer',
    segment: segmentFromOsmTags(tags),
    name: tidy(name, 160),
    city: tags['addr:city'] || city.name,
    state: tags['addr:state'] || city.state,
    address: osmAddress(tags),
    phone: tags.phone || tags['contact:phone'] || tags['contact:mobile'] || null,
    email: tags.email || tags['contact:email'] || null,
    website: tags.website || tags['contact:website'] || tags.url || null,
    whyNow: 'listed on OpenStreetMap',
    whyNowDate: null,
    source: 'overpass',
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    licence: OVERPASS.licence,
    externalId: `${el.type}/${el.id}`,
    extra: {
      osmType: el.type,
      osmId: el.id,
      lat,
      lon,
      tags: pickTags(tags),
      attribution: OVERPASS.attribution,
    },
  };
}

function pickTags(tags) {
  const keep = [
    'amenity', 'shop', 'tourism', 'craft', 'industrial', 'cuisine', 'opening_hours',
    'operator', 'brand', 'addr:city', 'addr:street', 'addr:postcode',
  ];
  const out = {};
  for (const k of keep) if (tags[k]) out[k] = tags[k];
  return out;
}

/** Parse a full Overpass JSON response body. */
export function parseResponse(text, city) {
  const data = JSON.parse(text);
  const out = [];
  for (const el of data.elements || []) {
    const c = elementToCandidate(el, city);
    if (c) out.push(c);
  }
  return out;
}

/** Contactable listings first, then alphabetical, so the cap keeps the useful ones. */
export function rankForCap(candidates) {
  const weight = (c) => (c.phone ? 0 : c.email ? 1 : c.website ? 2 : 3);
  return [...candidates].sort((a, b) => {
    const d = weight(a) - weight(b);
    if (d !== 0) return d;
    return a.externalId.localeCompare(b.externalId);
  });
}

/** Overpass answers 429 when no query slot is free, and 504 when a slot times out. */
export function isRetryable(status) {
  return status === 429 || status === 504;
}

export async function fetch(ctx) {
  const { city, log } = ctx;
  const all = [];
  const perGroup = {};
  let first = true;

  for (const group of OVERPASS_GROUPS) {
    if (!first) await sleep(OVERPASS.pauseMs);
    first = false;
    const query = buildQuery(group, city.bbox);

    let res = null;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      log(`overpass: ${city.key}/${group.key}${attempts > 1 ? ` (attempt ${attempts})` : ''}`);
      res = await request(OVERPASS.endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeoutMs: OVERPASS.httpTimeoutMs,
      });
      if (res.ok || !isRetryable(res.status) || attempts > OVERPASS.maxRetries) break;
      log(`overpass: ${group.key} HTTP ${res.status}, waiting ${OVERPASS.retryPauseMs} ms for a slot`);
      await sleep(OVERPASS.retryPauseMs);
    }

    if (!res.ok) {
      const reason =
        `HTTP ${res.status} from ${OVERPASS.endpoint} for group ${group.key} ` +
        `after ${attempts} attempt(s)`;
      log(`overpass: BLOCKED ${reason}`);
      return {
        candidates: all,
        detail: perGroup,
        blocked: { source: 'overpass', reason, status: res.status },
      };
    }

    const parsed = parseResponse(res.text, city);
    const capped = rankForCap(parsed).slice(0, OVERPASS.maxPerGroup);
    perGroup[group.key] = { parsed: parsed.length, kept: capped.length, ms: res.ms, attempts };
    all.push(...capped);
    log(`overpass: ${group.key} parsed=${parsed.length} kept=${capped.length} (${res.ms} ms)`);
  }

  return { candidates: all, detail: perGroup, attribution: OVERPASS.attribution };
}
