import { BASE } from './base.mjs';
// The owner's dashboard. One Node HTTP server, server-rendered HTML, no
// framework, no CDN, no client-side JavaScript at all.
//
//   RADAR_OWNER_TOKEN=... node src/dashboard/server.mjs
//
// It is owner-only: one bearer token, held in an HttpOnly SameSite=Strict
// cookie set by /login?t=<token>, or sent as Authorization: Bearer. With no
// RADAR_OWNER_TOKEN in the environment the server refuses to start - it never
// falls back to being open.
//
// The only thing it writes is a lead's status, and it writes that through the
// register API so a change made here produces exactly the same dated note,
// receipt and event as the same change made from the CLI. It sends nothing.

import http from 'node:http';
import { CLIENT } from '../config.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { openStore } from '../lib/store.mjs';
import { DIGESTS_DIR, RUNS_DIR } from '../lib/paths.mjs';
import { todayIso, STATUSES } from '../lib/normalise.mjs';
import { filterLeads, toCsv } from '../register.mjs';
import { callTool } from '../tools/registry.mjs';
import { catalogueItems } from '../lib/catalogue.mjs';
import { lastDays, isoWeek } from '../lib/week.mjs';
import { buildReport } from '../report.mjs';
import { todayPage, leadsPage, pricesPage, runsPage, ordersPage, loginPage, notFoundPage } from './pages.mjs';
import { recordOrder, orderRows, ordersToCsv } from '../orders.mjs';
import { latestDigest } from '../lib/digest-files.mjs';
import { handleWebhookRequest, webhookSummary, openWindow } from '../webhook.mjs';

export const COOKIE_NAME = 'radar_token';
export const DEFAULT_PORT = 4710;
export const LEADS_PAGE_SIZE = 60;
export const ORDERS_PAGE_SIZE = 200;
/** An order body is bigger than a status form; it is still nothing like a file. */
export const MAX_ORDER_BYTES = 64 * 1024;
export const PRICE_DAYS = 14;
const MAX_BODY_BYTES = 8 * 1024;

// ------------------------------------------------------------------ auth

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length || A.length === 0) return false;
  return timingSafeEqual(A, B);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function presentedToken(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

// ------------------------------------------------------------------ helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    // Everything is inline and same-origin; nothing is fetched from anywhere.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(payload);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Mean modal price per commodity per day, from the stored price leads. */
export function priceSeries(priceLeads, days) {
  const byCommodityDay = new Map();
  for (const lead of priceLeads) {
    const e = lead.extra || {};
    const day = e.whyNowDate;
    const modal = Number(e.modalPrice);
    if (!day || !e.commodity || !Number.isFinite(modal)) continue;
    const key = `${e.commodity}|${day}`;
    if (!byCommodityDay.has(key)) byCommodityDay.set(key, []);
    byCommodityDay.get(key).push(modal);
  }
  const rows = [];
  const unpriced = [];
  const seen = new Set();
  for (const item of catalogueItems()) {
    if (!item.commodity) {
      unpriced.push(item.label);
      continue;
    }
    if (seen.has(`${item.label}|${item.commodity}`)) continue;
    seen.add(`${item.label}|${item.commodity}`);
    const series = days.map((d) => {
      const values = byCommodityDay.get(`${item.commodity}|${d}`);
      if (!values || !values.length) return null;
      return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    });
    if (series.every((v) => v === null)) {
      unpriced.push(`${item.label} (no reading in ${days.length} days)`);
      continue;
    }
    rows.push({ ...item, series });
  }
  return { rows, unpriced };
}

const FILTER_KEYS = ['kind', 'status', 'segment', 'city', 'source', 'q'];

function readFilters(url) {
  const f = {};
  for (const k of FILTER_KEYS) {
    const v = (url.searchParams.get(k) || '').trim();
    if (v) f[k] = v;
  }
  return f;
}

function filterQuery(filters) {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k]);
  return p.toString();
}

/** Filters the register CLI does not have: source, and free-text name/phone. */
function applyExtraFilters(leads, filters) {
  const q = (filters.q || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const digits = q.replace(/\D/g, '');
  return leads.filter((l) => {
    if (filters.source && l.source !== filters.source) return false;
    if (!q) return true;
    if (String(l.name || '').toLowerCase().includes(q)) return true;
    if (digits.length >= 4 && String(l.phone || '').replace(/\D/g, '').includes(digits)) return true;
    return false;
  });
}

// ------------------------------------------------------------------ orders

function sendJson(res, status, value) {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end(payload);
}

function readJsonBody(req, limit = MAX_ORDER_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.tooLarge = true;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * POST /orders - one order from the site, by way of n8n.
 *
 * 503 with no RADAR_ORDERS_KEY, 401 on a wrong or missing key, 400 on a body
 * that is not an order, 200 with duplicate:true on a replay, 201 on a new one.
 * The answer carries the order reference, the lead the buyer now is, and what
 * became of the owner's alert - so the caller's own execution log records the
 * whole loop and not only that something was posted.
 */
export async function handleOrderRequest(req, res, ctx = {}) {
  const { env = process.env, storeFactory, runsDir = RUNS_DIR, fetchImpl, smtpConnect } = ctx;
  const expected = env.RADAR_ORDERS_KEY;
  if (!expected || String(expected).length < 8) {
    return sendJson(res, 503, {
      ok: false,
      error: 'RADAR_ORDERS_KEY is not set, so no order can be authenticated and none is accepted.',
    });
  }
  const presented = req.headers['x-farmquick-automation-key'];
  if (!safeEqual(presented, expected)) {
    return sendJson(res, 401, {
      ok: false,
      error: presented ? 'x-farmquick-automation-key does not match' : 'x-farmquick-automation-key is missing',
    });
  }

  let raw;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    if (err.tooLarge) return sendJson(res, 413, { ok: false, error: 'request body too large' });
    return sendJson(res, 400, { ok: false, error: 'could not read the body' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'body is not JSON' });
  }

  const store = await storeFactory();
  try {
    const result = await recordOrder(store, body, { env, fetchImpl, runsDir, smtpConnect });
    if (result.duplicate) {
      return sendJson(res, 200, {
        ok: true,
        duplicate: true,
        orderId: result.orderId,
        leadId: result.leadId,
        message: 'This order reference is already recorded; nothing was changed and nobody was told again.',
      });
    }
    return sendJson(res, 201, {
      ok: true,
      duplicate: false,
      orderId: result.orderId,
      leadId: result.leadId,
      leadCreated: result.leadCreated,
      matchedOn: result.matchedOn,
      status: 'won',
      alert: result.alert,
      receipt: result.receipt,
    });
  } catch (err) {
    const message = String(err.message || err);
    const status = message.startsWith('not an order') ? 400 : 500;
    if (status === 500) process.stderr.write(`[orders] POST failed: ${err.stack || err}\n`);
    return sendJson(res, status, { ok: false, error: status === 400 ? message : 'could not record the order' });
  } finally {
    await store.close();
  }
}

// ------------------------------------------------------------------ routing

async function handle(req, res, { token, digestsDir, runsDir, openStore: open }) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';

  // The webhook is the one route the owner token does not guard: Meta cannot
  // present it. What stands in its place is the app-secret signature on every
  // POST body, checked in src/webhook.mjs, which refuses an unsigned event.
  if (pathname === '/webhook') {
    return handleWebhookRequest(req, res, {
      env: process.env,
      url,
      storeFactory: open,
      digestsDir,
      runsDir,
    });
  }

  // The orders endpoint is the second route the owner token does not guard:
  // n8n cannot present it either. What stands in its place is
  // RADAR_ORDERS_KEY, compared in constant time against the same header the
  // site's Worker already sends. With the key unset the route answers 503 - it
  // never falls back to accepting an unauthenticated order.
  if (pathname === '/orders' && req.method === 'POST') {
    return handleOrderRequest(req, res, { env: process.env, storeFactory: open, runsDir });
  }

  // /login is the only route that accepts the token in the query string.
  if (pathname === '/login' && req.method === 'GET') {
    const given = url.searchParams.get('t') || '';
    if (!safeEqual(given, token)) {
      return send(res, 401, loginPage({ reason: 'That token does not match RADAR_OWNER_TOKEN.' }));
    }
    return redirect(res, `${BASE}/`, {
      'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000`,
    });
  }

  if (!safeEqual(presentedToken(req), token)) {
    return send(res, 401, loginPage(), { 'WWW-Authenticate': `Bearer realm="${CLIENT.digest.title}"` });
  }

  if (pathname === '/logout') {
    return redirect(res, `${BASE}/login`, {
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
  }

  const store = await open();
  try {
    // -------------------------------------------------- POST status change
    const statusMatch = pathname.match(/^\/leads\/([A-Za-z0-9_-]+)\/status$/);
    if (statusMatch && req.method === 'POST') {
      // The cookie is SameSite=Strict, so a cross-site POST never carries it;
      // the Origin check refuses anything that still arrives cross-origin.
      const origin = req.headers.origin;
      if (origin && origin !== url.origin) return send(res, 403, notFoundPage('bad origin'));
      const form = new URLSearchParams(await readBody(req));
      const status = form.get('status');
      const note = form.get('note');
      const back = form.get('back') || '';
      try {
        if (!STATUSES.includes(String(status))) throw new Error(`unknown status: ${status}`);
        // Through the tool layer, as the owner. The dashboard is the owner's own
        // page behind his own token, so the gate is satisfied here and refused
        // for an agent over MCP - and either way the write leaves both a
        // `tool.call` receipt and the same `lead.status_changed` receipt the CLI
        // has always written, because the tool calls the same function.
        const call = await callTool(
          'leads.set_status',
          { ref: statusMatch[1], status, note: note || null },
          { store, actor: 'owner', env: process.env, digestsDir, runsDir }
        );
        if (!call.ok) throw new Error(call.error);
        const r = call.output;
        const msg = `${r.name}: ${r.from} to ${r.to}. Receipt ${r.receiptHash.slice(0, 12)}.`;
        return redirect(res, `${BASE}/leads?${back}${back ? '&' : ''}m=${encodeURIComponent(msg)}`);
      } catch (err) {
        return redirect(res, `${BASE}/leads?${back}${back ? '&' : ''}e=${encodeURIComponent(err.message)}`);
      }
    }

    if (req.method !== 'GET') return send(res, 405, notFoundPage(`${req.method} ${pathname}`));

    const allLeads = await store.allLeads();
    const buyers = allLeads.filter((l) => l.kind !== 'price');
    const prices = allLeads.filter((l) => l.kind === 'price');
    const requirements = buyers.filter((l) => l.kind === 'requirement');
    const message = url.searchParams.get('m') || url.searchParams.get('e') || null;
    const messageKind = url.searchParams.get('e') ? 'bad' : 'ok';

    // -------------------------------------------------- /
    if (pathname === '/') {
      const digest = await latestDigest(digestsDir);
      const date = todayIso();
      const windowOpen = openWindow(await store.allEvents());
      return send(
        res,
        200,
        todayPage({
          date: digest.date && digest.date !== date ? `${date} (latest digest ${digest.date})` : date,
          digestText: digest.text,
          priceSheet: digest.priceSheet,
          counts: {
            total: buyers.length,
            newToday: buyers.filter((l) => String(l.first_seen).slice(0, 10) === date).length,
            withPhone: buyers.filter((l) => l.phone).length,
            prices: prices.length,
            // The number the owner actually opens this page for: buyers who
            // have POSTED what they need, and how many of those he can ring.
            requirements: requirements.length,
            requirementsWithContact: requirements.filter(
              (l) => l.phone || l.email || (l.extra || {}).contact_phone || (l.extra || {}).contact_email
            ).length,
            registrations: buyers.filter((l) => l.kind === 'registration').length,
          },
          funnel: {
            new: buyers.filter((l) => l.status === 'new').length,
            contacted: buyers.filter((l) => l.status === 'contacted').length,
            quoted: buyers.filter((l) => l.status === 'quoted').length,
            won: buyers.filter((l) => l.status === 'won').length,
            lost: buyers.filter((l) => l.status === 'lost').length,
          },
          windowOpen,
          message,
          messageKind,
        })
      );
    }

    // -------------------------------------------------- /leads
    if (pathname === '/leads') {
      const filters = readFilters(url);
      const matched = applyExtraFilters(
        filterLeads(buyers, {
          status: filters.status,
          city: filters.city,
          segment: filters.segment,
          kind: filters.kind,
        }),
        filters
      );
      const cities = [...new Set(buyers.map((l) => l.city).filter(Boolean))].sort();
      const sources = [...new Set(buyers.map((l) => l.source).filter(Boolean))].sort();
      return send(
        res,
        200,
        leadsPage({
          leads: matched.slice(0, LEADS_PAGE_SIZE),
          total: matched.length,
          limit: LEADS_PAGE_SIZE,
          filters,
          cities,
          sources,
          query: filterQuery(filters),
          message,
          messageKind,
        })
      );
    }

    // -------------------------------------------------- /export.csv
    if (pathname === '/export.csv') {
      const filters = readFilters(url);
      const matched = applyExtraFilters(
        filterLeads(buyers, { status: filters.status, city: filters.city, segment: filters.segment, kind: filters.kind }),
        filters
      );
      return send(res, 200, toCsv(matched), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="leads-${todayIso()}.csv"`,
      });
    }

    // -------------------------------------------------- /orders
    if (pathname === '/orders') {
      const orders = typeof store.allOrders === 'function' ? await store.allOrders() : [];
      const rows = orderRows(orders);
      return send(
        res,
        200,
        ordersPage({
          orders: rows.slice(0, ORDERS_PAGE_SIZE),
          total: rows.length,
          limit: ORDERS_PAGE_SIZE,
          message,
          messageKind,
        })
      );
    }

    if (pathname === '/orders.csv') {
      const orders = typeof store.allOrders === 'function' ? await store.allOrders() : [];
      return send(res, 200, ordersToCsv(orders), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-${todayIso()}.csv"`,
      });
    }

    // -------------------------------------------------- /prices
    if (pathname === '/prices') {
      const days = lastDays(PRICE_DAYS, todayIso());
      const { rows, unpriced } = priceSeries(prices, days);
      return send(res, 200, pricesPage({ days, rows, unpriced }));
    }

    // -------------------------------------------------- /runs
    const evidenceMatch = pathname.match(/^\/runs\/([A-Za-z0-9_-]+)\/evidence\.json$/);
    if (evidenceMatch) {
      try {
        const file = path.join(runsDir, `${evidenceMatch[1]}.evidence.json`);
        // The id pattern already excludes a separator, but resolve and check anyway.
        if (path.dirname(path.resolve(file)) !== path.resolve(runsDir)) throw new Error('outside runs/');
        const contents = await readFile(file, 'utf8');
        return send(res, 200, contents, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${evidenceMatch[1]}.evidence.json"`,
        });
      } catch {
        return send(res, 404, notFoundPage(pathname));
      }
    }

    if (pathname === '/runs') {
      const runs = await store.allRuns();
      let bundleFiles = new Set();
      try {
        bundleFiles = new Set(await readdir(runsDir));
      } catch {
        bundleFiles = new Set();
      }
      const rows = [...runs]
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
        .map((r) => ({
          id: r.id,
          city: r.city,
          sources: r.sources,
          startedAt: r.startedAt,
          candidates: r.summary?.candidates,
          leadsTotal: r.summary?.leadsTotal,
          blocked: r.summary?.blocked || [],
          llm: r.summary?.llm || null,
          openings: r.summary?.openings || null,
          bundleHash: r.bundleHash,
          hasBundle: bundleFiles.has(`${r.id}.evidence.json`),
        }));
      const webhook = webhookSummary(await store.allEvents());
      return send(res, 200, runsPage({ runs: rows, webhook }));
    }

    // -------------------------------------------------- /report/weekly
    if (pathname === '/report/weekly') {
      const week = url.searchParams.get('week') || isoWeek(new Date());
      const built = await buildReport({ week, store });
      return send(res, 200, built.html);
    }

    return send(res, 404, notFoundPage(pathname));
  } finally {
    await store.close();
  }
}

/**
 * Build the server. Throws when there is no token - the dashboard has no
 * unauthenticated mode, so starting without one would be a silent hole.
 */
export function createServer({
  token = process.env.RADAR_OWNER_TOKEN,
  digestsDir = DIGESTS_DIR,
  runsDir = RUNS_DIR,
  // Injectable so the test suite can serve a fixture store instead of data/.
  storeFactory = () => openStore(),
} = {}) {
  if (!token || String(token).length < 8) {
    throw new Error(
      'RADAR_OWNER_TOKEN is not set (or is shorter than 8 characters). The dashboard is owner-only and will not start without it.\n' +
        'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"'
    );
  }
  return http.createServer((req, res) => {
    handle(req, res, { token: String(token), digestsDir, runsDir, openStore: storeFactory }).catch((err) => {
      process.stderr.write(`[dashboard] ${req.method} ${req.url} failed: ${err.stack || err}\n`);
      if (!res.headersSent) send(res, 500, notFoundPage('server error'));
      else res.end();
    });
  });
}

async function main() {
  const port = Number(process.env.RADAR_PORT || DEFAULT_PORT);
  let server;
  try {
    server = createServer();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }
  server.listen(port, () => {
    process.stderr.write(
      `[dashboard] listening on http://0.0.0.0:${port}\n` +
        `[dashboard] sign in once at http://localhost:${port}/login?t=<RADAR_OWNER_TOKEN>\n`
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
