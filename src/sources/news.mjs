import { request, sleep } from '../lib/http.mjs';
import { NEWS } from '../config.mjs';
import { parseRssItems } from '../lib/xml.mjs';
import { isExcluded, tidy } from '../lib/normalise.mjs';
import { sha256Hex } from '../lib/hash.mjs';

export const name = 'news';

export function buildUrl(query) {
  const u = new URL(NEWS.base);
  u.searchParams.set('q', query);
  for (const [k, v] of Object.entries(NEWS.params)) u.searchParams.set(k, v);
  return u.toString();
}

function isoDate(pubDate) {
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * Google News item titles are "Headline - Publication". Keep the headline as
 * the lead name and the publication separately.
 */
export function splitTitle(title) {
  const i = title.lastIndexOf(' - ');
  if (i === -1) return { headline: title.trim(), publication: null };
  return { headline: title.slice(0, i).trim(), publication: title.slice(i + 3).trim() };
}

export function parseFeed(xml, { query, segment, city, feedUrl }) {
  const out = [];
  for (const item of parseRssItems(xml)) {
    if (!item.title || !item.link) continue;
    if (isExcluded(item.title)) continue;
    const { headline, publication } = splitTitle(item.title);
    const date = isoDate(item.pubDate);
    const externalId = item.guid || sha256Hex(item.link).slice(0, 24);
    out.push({
      kind: 'signal',
      segment,
      name: tidy(headline, 160),
      city: city ? city.name : null,
      state: city ? city.state : null,
      address: null,
      phone: null,
      email: null,
      website: null,
      whyNow: date ? `reported ${date}` : 'recent news item',
      whyNowDate: date,
      source: 'news',
      sourceUrl: item.link,
      licence: NEWS.licence,
      externalId,
      extra: {
        query,
        feedUrl,
        publication: publication || item.source || null,
        publishedAt: item.pubDate || null,
      },
    });
  }
  return out;
}

export async function fetch(ctx) {
  const { city, log } = ctx;
  const all = [];
  const detail = {};
  let first = true;

  for (const spec of NEWS.queries) {
    if (!first) await sleep(NEWS.pauseMs);
    first = false;
    const query = spec.q.replace('{city}', city.name);
    const url = buildUrl(query);
    const res = await request(url, { timeoutMs: NEWS.httpTimeoutMs });
    if (!res.ok) {
      const reason = `HTTP ${res.status} from Google News RSS for query ${JSON.stringify(query)}`;
      log(`news: BLOCKED ${reason}`);
      return { candidates: all, blocked: { source: 'news', reason, status: res.status } };
    }
    const parsed = parseFeed(res.text, {
      query,
      segment: spec.segment,
      city,
      feedUrl: url,
    }).slice(0, NEWS.maxPerQuery);
    detail[query] = { items: parsed.length, ms: res.ms };
    all.push(...parsed);
    log(`news: ${JSON.stringify(query)} items=${parsed.length} (${res.ms} ms)`);
  }

  return { candidates: all, detail };
}
