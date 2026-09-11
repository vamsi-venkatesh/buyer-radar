// Read the publisher, not Google.
//
// The news lane's items link to `news.google.com/rss/articles/<id>`, and
// `news.google.com/robots.txt` disallows that path for everybody. The openings
// lane obeyed the rule and therefore read nothing: twelve signals a run, twelve
// refusals. The fix is not to read Google's copy - it is to find out which
// publisher's page the item points at, and to go there, under that publisher's
// robots.txt.
//
// Two ways, in this order, and no third:
//
//   1. Decode the id. For a long time Google's article id was a base64url
//      protobuf with the publisher's URL inside it as a plain byte string. When
//      it decodes to one, that is the answer, and it costs no request at all.
//   2. Follow the redirect. A request that reads the Location header and never
//      the body, up to REDIRECT_HOPS times, and only if robots.txt allows the
//      request in the first place. The moment the chain leaves news.google.com,
//      that URL is the publisher's.
//
// If neither works the item is skipped with the reason recorded. Nothing here
// guesses a publisher URL from a headline, and nothing here fetches a path
// robots.txt disallows.

import { USER_AGENT } from '../config.mjs';
import { parseRobots, robotsAllows, uaToken } from '../llm/page.mjs';

export const GOOGLE_NEWS_HOSTS = ['news.google.com'];
export const REDIRECT_HOPS = 5;
export const RESOLVE_TIMEOUT_MS = 15000;

export function isGoogleNewsLink(raw) {
  try {
    return GOOGLE_NEWS_HOSTS.includes(new URL(String(raw)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The opaque id out of a /rss/articles/<id> or /articles/<id> link, or null. */
export function googleNewsId(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  const m = url.pathname.match(/\/articles\/([^/?#]+)/);
  return m ? m[1] : null;
}

const URL_RUN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

/**
 * Decode a Google News article id to the publisher URL it carries, or null.
 *
 * The id is base64url over a small protobuf. We do not parse the protobuf: we
 * decode the bytes and look for a printable http(s) run, which is what the URL
 * field is. An id that carries no such run - the post-2024 `AU_yqL...` form
 * carries none - returns null rather than a guess.
 */
export function decodeArticleId(id) {
  if (!id || typeof id !== 'string') return null;
  let bytes;
  try {
    bytes = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  } catch {
    return null;
  }
  if (!bytes) return null;
  const m = URL_RUN.exec(bytes);
  if (!m) return null;
  // The protobuf field that follows the URL starts with a byte outside the URL
  // character set, so the run ends where the URL ends. Parse it to be sure.
  try {
    const url = new URL(m[0]);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!url.hostname.includes('.')) return null;
    if (GOOGLE_NEWS_HOSTS.includes(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch {
    return null;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Follow the redirect chain without reading a body.
 *
 * `redirect: 'manual'` so each hop is visible and the body of the interstitial
 * is never downloaded - we want one header, not a page. Anything that is not a
 * redirect ends the walk: a 200 on news.google.com is the JavaScript
 * interstitial, which is not a redirect we are allowed to follow by executing
 * it, so it is a failure and says so.
 */
export async function followRedirect(
  startUrl,
  { fetchImpl = globalThis.fetch, userAgent = USER_AGENT, hops = REDIRECT_HOPS, timeoutMs = RESOLVE_TIMEOUT_MS } = {}
) {
  let url = startUrl;
  for (let i = 0; i < hops; i += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'User-Agent': userAgent, Accept: 'text/html;q=0.9,*/*;q=0.1' },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, reason: `${err.name}: ${err.message}`, url };
    }
    clearTimeout(timer);
    // Never read the body. We asked for one header.
    try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }

    const location = res.headers?.get?.('location');
    if (!location) {
      return {
        ok: false,
        reason: `HTTP ${res.status} with no Location header after ${i} redirect${i === 1 ? '' : 's'}`,
        url,
        status: res.status,
      };
    }
    let next;
    try {
      next = new URL(location, url).href;
    } catch {
      return { ok: false, reason: `unparseable Location header: ${String(location).slice(0, 120)}`, url };
    }
    url = next;
    const host = hostOf(url);
    if (host && !GOOGLE_NEWS_HOSTS.includes(host)) return { ok: true, url, host, hops: i + 1 };
  }
  return { ok: false, reason: `still on news.google.com after ${hops} redirects`, url };
}

/**
 * Resolve one news item link to the publisher's own article URL.
 *
 * Returns { ok, url, host, via, reason }. `via` is 'id' when the article id
 * carried the URL, 'redirect' when the chain led off Google, and 'direct' when
 * the item never pointed at Google in the first place - some feeds carry the
 * publisher's URL already and those are passed straight through.
 *
 * The redirect walk happens only when robots.txt allows the request. There is
 * no flag that turns that check off.
 */
export async function resolveNewsLink(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    userAgent = USER_AGENT,
    robotsFor = null,
    hops = REDIRECT_HOPS,
    timeoutMs = RESOLVE_TIMEOUT_MS,
  } = {}
) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: 'unparseable url', via: null };
  }
  if (!isGoogleNewsLink(url.href)) {
    return { ok: true, url: url.href, host: url.hostname, via: 'direct' };
  }

  const id = googleNewsId(url.href);
  const decoded = decodeArticleId(id);
  if (decoded) {
    return { ok: true, url: decoded, host: hostOf(decoded), via: 'id' };
  }

  // The id told us nothing. A request to Google is the only thing left, and it
  // happens only if Google's own robots.txt allows it.
  if (robotsFor) {
    let robots;
    try {
      robots = await robotsFor(url.origin);
    } catch (err) {
      return { ok: false, via: 'redirect', reason: `could not read ${url.origin}/robots.txt: ${err.name}` };
    }
    if (!robotsAllows(robots || { rules: [] }, url.pathname + url.search)) {
      return {
        ok: false,
        via: 'redirect',
        reason: `the article id carries no publisher URL, and ${url.origin}/robots.txt disallows ${url.pathname.slice(0, 40)} for ${uaToken(userAgent)}`,
      };
    }
  }

  const walked = await followRedirect(url.href, { fetchImpl, userAgent, hops, timeoutMs });
  if (walked.ok) return { ok: true, url: walked.url, host: walked.host, via: 'redirect', hops: walked.hops };
  return { ok: false, via: 'redirect', reason: `the article id carries no publisher URL and the link did not redirect: ${walked.reason}` };
}

export { parseRobots };
