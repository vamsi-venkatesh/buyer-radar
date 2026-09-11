// Fetching one page so the model has something real to read.
//
// The rules here are the same ones the sources follow: announce ourselves, obey
// robots.txt, one request every two seconds per host, and a hard cap on how much
// we will download. A page we are not allowed to read is recorded as blocked and
// the lead keeps its rule-based values. Nothing is ever fetched twice in a run.

import { USER_AGENT } from '../config.mjs';

export const PAGE = {
  maxBytes: 300 * 1024,
  maxChars: 6000,
  perHostPauseMs: 2000,
  timeoutMs: 20000,
};

/** The token robots.txt groups are matched against, e.g. "buyerradar". */
export function uaToken(userAgent = USER_AGENT) {
  return String(userAgent).split('/')[0].trim().toLowerCase();
}

/**
 * Parse robots.txt into the groups that apply to one agent token.
 * Returns { rules: [{ allow, path }] } with the rules of the most specific
 * matching group: our own token if it appears, otherwise "*".
 */
export function parseRobots(text, agent) {
  const groups = new Map();
  let current = [];
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      const name = value.toLowerCase();
      if (!lastWasAgent) current = [];
      if (!groups.has(name)) groups.set(name, current);
      else current = groups.get(name);
      groups.set(name, current);
      lastWasAgent = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      current.push({ allow: field === 'allow', path: value });
    }
  }
  const own = groups.get(String(agent).toLowerCase());
  const star = groups.get('*');
  return { rules: own || star || [], matched: own ? agent : star ? '*' : null };
}

function robotsPathMatches(pattern, pathname) {
  if (pattern === '') return false; // "Disallow:" with an empty value allows everything
  // robots.txt wildcards: * matches any run of characters, $ anchors the end.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(pathname);
  } catch {
    return pathname.startsWith(pattern);
  }
}

/**
 * Longest-match wins; an Allow of equal length beats a Disallow, which is the
 * behaviour the major crawlers document. With no matching rule, fetching is
 * allowed - robots.txt is a list of refusals, not a list of permissions.
 */
export function robotsAllows(robots, pathname) {
  let best = null;
  for (const rule of robots.rules || []) {
    if (!robotsPathMatches(rule.path, pathname)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BLOCK_TAGS = 'p|div|section|article|header|footer|li|tr|br|h1|h2|h3|h4|h5|h6|table|ul|ol|blockquote|figcaption';

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&ndash;': '-', '&mdash;': '-', '&hellip;': '...', '&rupee;': 'Rs', '&#8377;': 'Rs',
};

/** Strip a page down to the text a reader would see. No DOM, no dependency. */
export function htmlToText(html, { maxChars = PAGE.maxChars } = {}) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*\/?>/gi, ' ');
  s = s.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  });
  s = s.replace(/&[a-z]+;|&#x[0-9a-f]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars).trimEnd()}`;
}

/**
 * The <title> of a page, as a reader would see it in the tab.
 *
 * It is a concrete fact about a business - "Sri Venkateshwara Traders,
 * wholesale vegetables, Bengaluru" - and the "model only when needed" rules
 * count it as one, so it is carried out of the fetch rather than thrown away
 * with the rest of the markup.
 */
export function pageTitle(html, { maxChars = 160 } = {}) {
  const m = /<title\b[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(String(html || ''));
  if (!m) return null;
  const text = htmlToText(m[1], { maxChars }).replace(/\s+/g, ' ').trim();
  return text || null;
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/**
 * A promise that only ever rejects, when the signal aborts.
 *
 * The timeout has to cover the body, not just the headers. Handing the signal
 * to `fetch` and then clearing the timer the moment `fetch` resolves leaves a
 * stalled body with nothing to interrupt it - a server that sends headers and
 * then goes quiet holds the read open for as long as it likes. That stopped a
 * real run dead in the enrich stage, with no error and no log line.
 */
function abortsAt(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

/** Read at most maxBytes of a response body, then stop reading. */
async function readCapped(res, maxBytes, signal) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await Promise.race([res.text(), abortsAt(signal)]);
    const buf = Buffer.from(text, 'utf8');
    return { text: buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') : text, bytes: buf.length, truncated: buf.length > maxBytes };
  }
  const reader = res.body.getReader();
  const stop = abortsAt(signal);
  stop.catch(() => {});
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stop]);
      if (done) break;
      bytes += value.byteLength;
      chunks.push(Buffer.from(value));
      if (bytes >= maxBytes) {
        truncated = true;
        try { await reader.cancel(); } catch { /* the body is already gone; nothing to cancel */ }
        break;
      }
    }
  } catch (err) {
    try { reader.cancel(); } catch { /* already closed */ }
    throw err;
  }
  return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), bytes, truncated };
}

/**
 * One fetcher per run. It remembers robots.txt per host, the last request time
 * per host, and every URL it has already read, so a run never asks the same
 * question of the same server twice.
 */
export function createPageFetcher({
  fetchImpl = globalThis.fetch,
  userAgent = USER_AGENT,
  sleep = sleepMs,
  now = () => Date.now(),
  perHostPauseMs = PAGE.perHostPauseMs,
  maxBytes = PAGE.maxBytes,
  maxChars = PAGE.maxChars,
  timeoutMs = PAGE.timeoutMs,
} = {}) {
  const agent = uaToken(userAgent);
  const robotsByHost = new Map();
  const lastRequestAt = new Map();
  const seen = new Map();

  const pace = async (host) => {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = perHostPauseMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
  };

  /**
   * Fetch and read under one deadline. `read` is called inside the same window
   * the fetch was made in, so the timeout covers the body too.
   */
  const getAndRead = async (url, read) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': userAgent, Accept: 'text/html,text/plain;q=0.9', 'Accept-Language': 'en-IN,en;q=0.9' },
      });
      return await read(res, ac.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const robotsFor = async (origin) => {
    if (robotsByHost.has(origin)) return robotsByHost.get(origin);
    let robots = { rules: [], matched: null, source: 'none' };
    try {
      await pace(new URL(origin).host);
      robots = await getAndRead(`${origin}/robots.txt`, async (res, signal) => {
        if (res.status !== 200) {
          // No robots.txt, or one we are not served, is not a refusal.
          return { rules: [], matched: null, source: `status ${res.status}` };
        }
        const { text } = await readCapped(res, maxBytes, signal);
        return { ...parseRobots(text, agent), source: 'fetched' };
      });
    } catch (err) {
      robots = { rules: [], matched: null, source: `error: ${err.name}` };
    }
    robotsByHost.set(origin, robots);
    return robots;
  };

  return {
    /**
     * Returns { ok, text, url, reason, bytes, truncated, cached }.
     * ok:false is always a recorded reason, never an exception the caller has to
     * guess at, and never an empty string pretending to be a page.
     */
    async fetchText(rawUrl) {
      let url;
      try {
        url = new URL(String(rawUrl));
      } catch {
        return { ok: false, reason: 'unparseable url', url: String(rawUrl) };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `unsupported protocol ${url.protocol}`, url: url.href };
      }
      if (seen.has(url.href)) return { ...seen.get(url.href), cached: true };

      const robots = await robotsFor(url.origin);
      if (!robotsAllows(robots, url.pathname + url.search)) {
        const out = { ok: false, reason: `robots.txt disallows ${url.pathname} for ${agent}`, url: url.href, robots: robots.matched };
        seen.set(url.href, out);
        return out;
      }

      let out;
      try {
        await pace(url.host);
        out = await getAndRead(url.href, async (res, signal) => {
          if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, url: url.href };
          const type = String(res.headers?.get?.('content-type') || '');
          if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
            return { ok: false, reason: `content-type ${type.split(';')[0]}`, url: url.href };
          }
          const { text, bytes, truncated } = await readCapped(res, maxBytes, signal);
          const plain = htmlToText(text, { maxChars });
          return plain
            ? { ok: true, text: plain, title: pageTitle(text), url: res.url || url.href, bytes, truncated, chars: plain.length }
            : { ok: false, reason: 'no readable text on the page', url: url.href, bytes };
        });
      } catch (err) {
        out = { ok: false, reason: `${err.name}: ${err.message}`, url: url.href };
      }
      seen.set(url.href, out);
      return out;
    },

    stats() {
      return { hosts: robotsByHost.size, urls: seen.size };
    },
  };
}
