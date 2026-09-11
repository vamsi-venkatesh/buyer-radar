import { request, sleep } from '../lib/http.mjs';
import { CPPP } from '../config.mjs';
import { parseInputs, parseTableRows, parseLinks, stripTags } from '../lib/xml.mjs';
import { tidy } from '../lib/normalise.mjs';

export const name = 'cppp';

/**
 * Central Public Procurement Portal.
 *
 * Every public listing surface on eprocure.gov.in is gated behind an image
 * captcha ("Provide Captcha and click on Search button to list all active
 * tenders"). This source detects that gate and records `blocked: captcha`.
 * It does not attempt to read, solve or bypass a captcha, and it stops on the
 * first 403 or 429.
 */

export function pageUrl(page) {
  return `${CPPP.base}?page=${encodeURIComponent(page)}&service=page`;
}

export function detectGate(html) {
  const hasCaptchaField = parseInputs(html).some((i) => /captcha/i.test(i.name));
  const text = stripTags(html);
  const saysProvideCaptcha = /provide\s+captcha/i.test(text);
  const sessionExpired = /session in the client area has expired/i.test(text);
  if (hasCaptchaField || saysProvideCaptcha) {
    return {
      gated: true,
      kind: 'captcha',
      evidence: saysProvideCaptcha
        ? 'page states "Provide Captcha and click on Search button to list all active tenders."'
        : 'page carries a required captchaText input',
    };
  }
  if (sessionExpired) {
    return { gated: true, kind: 'session', evidence: 'portal returned a session-expired page' };
  }
  return { gated: false };
}

/** Hidden form state needed for a keyword POST, read from the search page. */
export function readFormState(html) {
  const state = {};
  for (const i of parseInputs(html)) {
    if (!i.name) continue;
    if (i.type === 'hidden') state[i.name] = i.value;
  }
  return state;
}

/** Parse a CPPP results table into tender candidates. */
export function parseTenderRows(html, keyword) {
  const rows = parseTableRows(html);
  const links = parseLinks(html);
  const out = [];
  for (const cells of rows) {
    if (cells.length < 5) continue;
    const joined = cells.join(' ');
    if (/tender\s*id/i.test(cells[0]) || /s\.?\s*no/i.test(cells[0])) continue;
    const idMatch = joined.match(/\b(\d{4}_[A-Z0-9_]+_\d+_\d+)\b/);
    if (!idMatch) continue;
    const tenderId = idMatch[1];
    const closing = (joined.match(/(\d{2}-[A-Za-z]{3}-\d{4})/g) || [])[1] || null;
    const link = links.find((l) => l.text.includes(tenderId) || l.href.includes(tenderId));
    const title = cells.find((c) => c.length > 20 && !c.includes(tenderId)) || tenderId;
    const organisation = cells[cells.length - 1] || null;
    out.push({
      kind: 'tender',
      segment: 'institution',
      name: tidy(title, 160),
      city: null,
      state: null,
      address: null,
      phone: null,
      email: null,
      website: null,
      whyNow: closing ? `tender closes ${closing}` : 'open tender',
      whyNowDate: closing ? toIso(closing) : null,
      source: 'cppp',
      sourceUrl: link ? new URL(link.href, CPPP.base).toString() : pageUrl('FrontEndAdvancedSearch'),
      licence: CPPP.licence,
      externalId: tenderId,
      extra: { tenderId, organisation, keyword, closingRaw: closing },
    });
  }
  return out;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function toIso(ddMonYyyy) {
  const m = String(ddMonYyyy).match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1]}` : null;
}

export async function fetch(ctx) {
  const { log } = ctx;
  const probes = [];
  let first = true;

  for (const page of CPPP.pages) {
    if (!first) await sleep(CPPP.pauseMs);
    first = false;
    const url = pageUrl(page);
    const res = await request(url, { timeoutMs: CPPP.httpTimeoutMs });
    probes.push({ page, status: res.status, bytes: res.text.length, ms: res.ms });

    if (res.status === 403 || res.status === 429) {
      const reason = `HTTP ${res.status} from ${url} - stopped, no retry`;
      log(`cppp: BLOCKED ${reason}`);
      return { candidates: [], blocked: { source: 'cppp', reason, status: res.status }, detail: { probes } };
    }
    if (!res.ok) {
      log(`cppp: ${page} HTTP ${res.status}`);
      continue;
    }

    const gate = detectGate(res.text);
    if (gate.gated && gate.kind === 'captcha') {
      const reason =
        `captcha - ${url} requires an image captcha before any tender list is returned ` +
        `(${gate.evidence}). No captcha is read, solved or bypassed; the source stops here.`;
      log(`cppp: BLOCKED captcha on ${page}`);
      return {
        candidates: [],
        blocked: { source: 'cppp', reason, status: res.status, kind: 'captcha' },
        detail: { probes, keywords: CPPP.keywords },
      };
    }
    if (gate.gated) {
      log(`cppp: ${page} gated (${gate.kind})`);
      continue;
    }

    // No gate on this page: read it as a keyword-filtered tender listing.
    const found = [];
    for (const keyword of CPPP.keywords) {
      for (const c of parseTenderRows(res.text, keyword)) {
        if (`${c.name} ${c.extra.organisation || ''}`.toLowerCase().includes(keyword)) found.push(c);
      }
    }
    if (found.length) {
      log(`cppp: ${page} matched ${found.length} tender rows`);
      return { candidates: dedupeById(found), detail: { probes } };
    }
  }

  return {
    candidates: [],
    blocked: {
      source: 'cppp',
      reason:
        'no ungated tender listing found - every probed CPPP listing page was captcha-gated or ' +
        'returned no parsable tender rows',
      kind: 'no-open-listing',
    },
    detail: { probes },
  };
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((c) => {
    if (seen.has(c.externalId)) return false;
    seen.add(c.externalId);
    return true;
  });
}
