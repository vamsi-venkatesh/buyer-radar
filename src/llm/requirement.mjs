// The requirement answer: what the model is asked about a news article, and how
// its reply is read. Kept beside enrich.mjs and built the same way, so the
// evaluation harness can score the contract the pipeline actually uses.

import { extractJson } from './enrich.mjs';

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).trimEnd();
}

function str(v, n) {
  return typeof v === 'string' && v.trim() ? clip(v, n) : null;
}

/** The text the model is asked to read: the headline on record, then the article. */
export function requirementInput({ headline = null, city = null, url = null, text = '' }) {
  const head = [
    headline ? `Headline on record: ${headline}` : null,
    city ? `City the search was run for: ${city}` : null,
    url ? `Article URL: ${url}` : null,
  ].filter(Boolean);
  return `${head.join('\n')}\n\nArticle text:\n${String(text).trim()}`.trim();
}

// A site the model returns is only followed when it is a plain http(s) host.
// Search engines, news sites and social pages are refused here rather than in
// the crawler, so the refusal is visible in the answer that produced it.
const REFUSED_HOSTS =
  /(?:^|\.)(?:google|bing|duckduckgo|yahoo|baidu|yandex)\.|(?:^|\.)(?:facebook|instagram|twitter|x|linkedin|youtube|wikipedia|tripadvisor|zomato|swiggy)\.|(?:^|\.)(?:timesofindia|thehindu|indianexpress|hindustantimes|ndtv|deccanherald|livemint|business-standard|economictimes|news18|telanganatoday|newindianexpress)\./i;

/**
 * The website the pipeline may follow from a model answer, or null with a
 * reason. This is the one place a model gets to point the crawler at a host, so
 * it is also the place that says no.
 */
export function resolveSite(raw) {
  const s = str(raw, 200);
  if (!s) return { ok: false, reason: 'the article gave no website' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { ok: false, reason: `not a usable URL: ${clip(s, 60)}` };
  }
  if (!url.hostname.includes('.')) return { ok: false, reason: `not a usable host: ${clip(url.hostname, 60)}` };
  if (REFUSED_HOSTS.test(url.hostname)) {
    return { ok: false, reason: `refused host ${url.hostname} - a search engine, news site or social page is not the buyer's own site` };
  }
  return { ok: true, url: `${url.protocol}//${url.host}`, host: url.hostname };
}

/**
 * Read a reply into the requirement answer.
 *
 * `is_requirement` and `confidence` are the two fields the pipeline branches on,
 * so a reply missing either is malformed and earns the one repair attempt.
 * Everything else is optional by design: an article that names no contact and no
 * quantity is a normal article, not a bad answer.
 */
export function parseRequirement(text) {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, malformed: true };
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, reason: 'reply is not a JSON object', malformed: true };
  }
  const problems = [];
  if (typeof v.is_requirement !== 'boolean') problems.push('is_requirement is missing or not true/false');
  if (typeof v.confidence !== 'number' || Number.isNaN(v.confidence)) problems.push('confidence is missing or not a number');
  if (problems.length) return { ok: false, reason: problems.join('; '), malformed: true, problems };

  const deadline = isIsoDate(v.deadline) ? v.deadline : null;
  return {
    ok: true,
    value: {
      isRequirement: v.is_requirement,
      organisation: str(v.organisation, 160),
      city: str(v.city, 80),
      requirement: str(v.requirement, 200),
      quantity: str(v.quantity, 120),
      deadline,
      deadlineDropped: v.deadline != null && deadline === null ? clip(v.deadline, 40) : null,
      contactHint: str(v.contact_hint, 120),
      site: str(v.site, 200),
      evidence: Array.isArray(v.evidence)
        ? v.evidence.filter((e) => typeof e === 'string' && e.trim()).slice(0, 4).map((e) => clip(e, 120))
        : [],
      confidence: Math.max(0, Math.min(1, Number(v.confidence))),
    },
  };
}
