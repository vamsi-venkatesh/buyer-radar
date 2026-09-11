// One polite crawler, shared by every source in the demand lane.
//
// The rules are the ones the project has followed from the start and are not
// negotiable per source: announce ourselves, read robots.txt before the first
// page of a host and obey it, leave a fixed pause between requests to the same
// host, cap what we download, and never fetch the same URL twice in a run.
//
// It differs from the LLM stage's page fetcher in exactly two ways, both needed
// by the demand lane: it hands back the raw HTML as well as the text, because a
// notice list is read as links rather than as prose, and it reads PDFs, because
// that is what a tender notice usually is.

import { USER_AGENT } from '../config.mjs';
import { parseRobots, robotsAllows, uaToken, htmlToText } from '../llm/page.mjs';
import { pdfToText, looksLikePdf } from './pdf-text.mjs';

export const CRAWL = {
  perHostPauseMs: 3000, // 1 request every 3 s per host
  maxBytes: 2 * 1024 * 1024, // 2 MB, the cap the demand lane documents for PDFs
  maxTextChars: 20000,
  timeoutMs: 30000,
};

const ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8';

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/**
 * A promise that only ever rejects, when the signal aborts.
 *
 * Read against the body read below, this is what makes the deadline real. It is
 * not enough to hand the signal to `fetch`: a stalled body leaves
 * `reader.read()` pending forever, and whether aborting the fetch rejects that
 * read is an implementation detail we should not be relying on.
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

async function readCapped(res, maxBytes, signal) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await Promise.race([res.arrayBuffer(), abortsAt(signal)]));
    return { buf: buf.subarray(0, maxBytes), bytes: buf.length, truncated: buf.length > maxBytes };
  }
  const reader = res.body.getReader();
  const stop = abortsAt(signal);
  // An abort rejection with nothing attached is an unhandled rejection the
  // moment the happy path finishes first.
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
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
    }
  } catch (err) {
    try { reader.cancel(); } catch { /* already closed */ }
    throw err;
  }
  return { buf: Buffer.concat(chunks).subarray(0, maxBytes), bytes, truncated };
}

/**
 * What actually went wrong, in the words the failure used.
 *
 * `fetch failed` on its own is useless: a host that times out, a host that
 * resets the connection and a host whose TLS chain is incomplete are three
 * different facts about the world, and only the last one is our problem to
 * think about. The cause code is carried through so the probe file records the
 * difference rather than flattening it into "unreachable".
 */
export function describeFetchError(err) {
  const cause = err && err.cause;
  const code = cause && (cause.code || cause.name);
  if (code) return `${err.name}: ${err.message} (${code}${cause.message && cause.message !== err.message ? `: ${cause.message}` : ''})`;
  return `${err.name}: ${err.message}`;
}

export function createCrawler({
  fetchImpl = globalThis.fetch,
  userAgent = USER_AGENT,
  sleep = sleepMs,
  now = () => Date.now(),
  perHostPauseMs = CRAWL.perHostPauseMs,
  maxBytes = CRAWL.maxBytes,
  maxTextChars = CRAWL.maxTextChars,
  timeoutMs = CRAWL.timeoutMs,
} = {}) {
  const agent = uaToken(userAgent);
  const robotsByOrigin = new Map();
  const lastRequestAt = new Map();
  const seen = new Map();
  const counts = { requests: 0, robots: 0, blockedByRobots: 0, pdfs: 0, html: 0 };

  const pace = async (host) => {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = perHostPauseMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
  };

  /**
   * Fetch and read one response under a single deadline.
   *
   * The deadline covers the body, not just the headers. Clearing the timer as
   * soon as `fetch` resolves looks harmless and is not: a server that sends its
   * headers and then stalls the body leaves the read waiting with nothing to
   * abort it. That is not hypothetical - it hung a real institutional crawl
   * indefinitely, with no error and no log line, because `mapPool` waits for
   * every lane and one lane never came back.
   */
  const getAndRead = async (url, cap = maxBytes) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      counts.requests += 1;
      const res = await fetchImpl(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': userAgent, Accept: ACCEPT, 'Accept-Language': 'en-IN,en;q=0.9' },
      });
      const status = res.status;
      const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
      const finalUrl = res.url || url;
      if (!res.ok) {
        // Drain nothing: the body of an error page is of no use to us and
        // reading it is one more thing that can stall.
        try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
        return { status, type, url: finalUrl, ok: false };
      }
      const body = await readCapped(res, cap, ac.signal);
      return { status, type, url: finalUrl, ok: true, ...body };
    } finally {
      clearTimeout(timer);
    }
  };

  const robotsFor = async (origin) => {
    if (robotsByOrigin.has(origin)) return robotsByOrigin.get(origin);
    let robots = { rules: [], matched: null, source: 'none' };
    try {
      await pace(new URL(origin).host);
      counts.robots += 1;
      const res = await getAndRead(`${origin}/robots.txt`, 256 * 1024);
      if (res.status === 200 && res.buf) {
        robots = { ...parseRobots(res.buf.toString('utf8'), agent), source: 'fetched' };
      } else {
        // No robots.txt, or one we are not served, is not a refusal.
        robots = { rules: [], matched: null, source: `status ${res.status}` };
      }
    } catch (err) {
      robots = { rules: [], matched: null, source: `error: ${err.name}` };
    }
    robotsByOrigin.set(origin, robots);
    return robots;
  };

  return {
    stats: () => ({ ...counts, hosts: robotsByOrigin.size, urls: seen.size }),
    robotsFor,

    /**
     * Fetch one document.
     *
     * Returns `{ ok, kind: 'html' | 'pdf', text, html, status, url, bytes }` or
     * `{ ok: false, reason }`. A PDF that cannot be read comes back as
     * `ok: false, reason: 'unreadable'` with the detail attached - the caller is
     * expected to record that, not to treat it as an empty page.
     */
    async fetchDoc(rawUrl) {
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
        counts.blockedByRobots += 1;
        const out = {
          ok: false,
          reason: `robots.txt disallows ${url.pathname} for ${agent}`,
          kind: 'robots',
          url: url.href,
        };
        seen.set(url.href, out);
        return out;
      }

      let out;
      try {
        await pace(url.host);
        const res = await getAndRead(url.href);
        const type = res.type;
        if (!res.ok) {
          out = { ok: false, reason: `HTTP ${res.status}`, status: res.status, url: res.url };
        } else {
          const { buf, bytes, truncated } = res;
          const isPdf = /application\/pdf/.test(type) || looksLikePdf(buf);
          if (isPdf) {
            counts.pdfs += 1;
            const parsed = pdfToText(buf, { maxChars: maxTextChars });
            out = parsed.ok
              ? {
                  ok: true, kind: 'pdf', text: parsed.text, html: null, status: res.status,
                  url: res.url, bytes, truncated: truncated || Boolean(parsed.truncated),
                  streams: parsed.streams, decoded: parsed.decoded,
                }
              : {
                  ok: false, kind: 'pdf', reason: parsed.reason, detail: parsed.detail || null,
                  status: res.status, url: res.url, bytes,
                };
          } else if (!type || /text\/html|application\/xhtml|text\/plain/.test(type)) {
            counts.html += 1;
            const html = buf.toString('utf8');
            const text = htmlToText(html, { maxChars: maxTextChars });
            out = text
              ? { ok: true, kind: 'html', text, html, status: res.status, url: res.url, bytes, truncated }
              : { ok: false, kind: 'html', reason: 'no readable text on the page', status: res.status, url: res.url, bytes };
          } else {
            out = { ok: false, reason: `content-type ${type.split(';')[0]}`, status: res.status, url: res.url, bytes };
          }
        }
      } catch (err) {
        out = { ok: false, reason: describeFetchError(err), url: url.href };
      }
      seen.set(url.href, out);
      return out;
    },
  };
}

/**
 * Run `worker` over `items` with a fixed number in flight.
 *
 * Results come back in input order, so the pipeline stays deterministic while
 * the crawl spends its time on different hosts at once rather than waiting out
 * one host's pause with every other host idle.
 */
export async function mapPool(items, concurrency, worker) {
  const list = [...items];
  const out = new Array(list.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await worker(list[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}
