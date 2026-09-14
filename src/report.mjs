// Weekly report. Every number here is counted from the store - leads, runs and
// events. Nothing is estimated and nothing is sent.
//
//   node src/report.mjs [--week 2026-W37]
//
// Writes reports/<week>.txt (WhatsApp-shaped, <= REPORT.maxChars) and
// reports/<week>.html.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT } from './config.mjs';
import { ROOT } from './lib/paths.mjs';
import { openStore } from './lib/store.mjs';
import { isoWeek, weekRange, previousWeek, inWeek, shortDate } from './lib/week.mjs';
import { segmentLabel, normaliseCity, todayIso } from './lib/normalise.mjs';
import { catalogueItems } from './lib/catalogue.mjs';
import { page, esc } from './dashboard/layout.mjs';
import { orderLines, ORDER_SITE } from './orders.mjs';

export const REPORTS_DIR = path.join(ROOT, 'reports');
export const REPORT = { maxChars: 1800, topCities: 5, topSegments: 6, topPriceItems: 6, topWon: 6 };

const SEGMENT_PLURALS = {
  wholesale: 'wholesale buyers',
  restaurant: 'restaurants',
  hotel: 'hotels',
  caterer: 'caterers',
  retailer: 'retailers',
  food_manufacturer: 'food manufacturers',
  distributor: 'distributors',
  institution: 'institutions',
  other: 'unclassified leads',
};

const plural = (segment) => SEGMENT_PLURALS[segment] || `${segmentLabel(segment)} leads`;

function countBy(rows, key) {
  const m = new Map();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === undefined || k === '') continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/** "Bengaluru 12, Kolar 3, +2 more" - never hides the fact that it trimmed. */
function topList(pairs, n, format = (k, v) => `${k} ${v}`) {
  const shown = pairs.slice(0, n).map(([k, v]) => format(k, v));
  const restCount = pairs.length - shown.length;
  const restSum = pairs.slice(n).reduce((a, [, v]) => a + v, 0);
  if (restCount > 0) shown.push(`+${restCount} more (${restSum})`);
  return shown.join(', ') || 'none';
}

/**
 * Group by a comparison key but label with the spelling that actually appears
 * most often in the store, so "Bengaluru", "bengaluru" and "Bengaluru," are one
 * row without any of them being rewritten into something the store never held.
 */
function countByNormalised(rows, rawKey, normKey) {
  const groups = new Map();
  for (const row of rows) {
    const raw = rawKey(row);
    if (!raw) continue;
    const k = normKey(raw);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { total: 0, spellings: new Map() });
    const g = groups.get(k);
    g.total += 1;
    g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
  }
  return [...groups.values()]
    .map((g) => {
      // Most common spelling wins. The tie-break is a plain code-unit
      // comparison rather than localeCompare, so the answer does not depend on
      // the ICU data the host happens to ship.
      const label = [...g.spellings.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      )[0][0];
      return [label, g.total];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Average modal price per Agmarknet commodity over a week, from stored price
 * leads. A commodity with no reading in that week is simply absent - it is
 * never carried over from another week.
 */
function weeklyModal(priceLeads, range) {
  const buckets = new Map();
  for (const lead of priceLeads) {
    const e = lead.extra || {};
    const day = e.whyNowDate || null;
    const modal = e.modalPrice;
    if (!day || !inWeek(day, range)) continue;
    if (modal === null || modal === undefined || !Number.isFinite(Number(modal))) continue;
    if (!buckets.has(e.commodity)) buckets.set(e.commodity, []);
    buckets.get(e.commodity).push(Number(modal));
  }
  const out = new Map();
  for (const [commodity, values] of buckets) {
    out.set(commodity, { mean: mean(values), readings: values.length });
  }
  return out;
}

/**
 * Fold the store into every number the report prints. Pure: give it rows, it
 * gives you counts. No I/O, no clock beyond the `today` you pass in.
 */
export function collectReport({ leads = [], runs = [], events = [], orders = [], week, today = todayIso() }) {
  const range = weekRange(week);
  const prior = previousWeek(week);
  const priorRange = weekRange(prior);

  const priceLeads = leads.filter((l) => l.kind === 'price');
  const buyerLeads = leads.filter((l) => l.kind !== 'price');

  const foundThisWeek = buyerLeads.filter((l) => inWeek(l.first_seen, range));
  const withPhone = foundThisWeek.filter((l) => l.phone).length;
  const noContact = buyerLeads.filter((l) => !l.phone && !l.email && !l.website).length;

  // ---- status changes recorded this week
  const changes = events.filter((e) => e.type === 'lead.status_changed' && inWeek(e.at, range));
  const byId = new Map(leads.map((l) => [l.id, l]));
  const statusCounts = {};
  for (const c of changes) statusCounts[c.to] = (statusCounts[c.to] || 0) + 1;
  const wonNames = changes
    .filter((c) => c.to === 'won')
    .map((c) => (byId.get(c.leadId) ? byId.get(c.leadId).name : c.leadId));

  // ---- runs this week
  const weekRuns = runs.filter((r) => inWeek(r.startedAt, range));
  const sourceCounts = new Map();
  const blocked = new Map();
  const runDays = new Set();
  for (const r of weekRuns) {
    runDays.add(String(r.startedAt).slice(0, 10));
    const per = (r.summary && r.summary.perSource) || {};
    for (const [name, d] of Object.entries(per)) {
      sourceCounts.set(name, (sourceCounts.get(name) || 0) + (d.count || 0));
    }
    for (const b of (r.summary && r.summary.blocked) || []) {
      if (!blocked.has(b.source)) blocked.set(b.source, b.reason);
    }
  }
  // Days of the week that have already happened, so a mid-week report does not
  // report the days still to come as missed.
  const elapsedDays = [];
  for (let d = new Date(`${range.start}T00:00:00.000Z`); d.toISOString().slice(0, 10) <= range.end; d = new Date(d.getTime() + 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso <= today) elapsedDays.push(iso);
  }
  const daysWithoutRun = elapsedDays.filter((d) => !runDays.has(d));

  // ---- price movement, this week against last week
  const thisWeekPrices = weeklyModal(priceLeads, range);
  const lastWeekPrices = weeklyModal(priceLeads, priorRange);
  const seenCommodity = new Set();
  const priceMoves = [];
  for (const item of catalogueItems()) {
    if (!item.commodity || seenCommodity.has(item.commodity)) continue;
    const now = thisWeekPrices.get(item.commodity);
    if (!now) continue;
    seenCommodity.add(item.commodity);
    const before = lastWeekPrices.get(item.commodity) || null;
    const deltaPct =
      before && before.mean ? Math.round(((now.mean - before.mean) / before.mean) * 100) : null;
    priceMoves.push({
      id: item.id,
      label: item.label,
      commodity: item.commodity,
      approx: item.approx,
      thisWeek: now.mean,
      lastWeek: before ? before.mean : null,
      readings: now.readings,
      deltaPct,
    });
  }
  priceMoves.sort((a, b) => b.readings - a.readings || a.label.localeCompare(b.label));

  // ---- untouched buckets, used by the next actions
  const untouched = countBy(
    buyerLeads.filter((l) => l.status === 'new' && l.phone),
    (l) => `${l.segment}|${l.city || 'unknown city'}`
  ).map(([k, v]) => {
    const [segment, city] = k.split('|');
    return { segment, city, count: v };
  });

  // ---- orders placed on the client's own site this week
  const weekOrders = orders.filter((o) => inWeek(o.createdAt || o.receivedAt, range));
  const orderProducts = new Map();
  for (const o of weekOrders) {
    const items = (o.products && o.products.length ? o.products : orderLines(o)).map((p) => String(p).trim()).filter(Boolean);
    // The same product named twice in one order is one order for that product.
    for (const item of new Set(items.map((i) => i.toLowerCase()))) {
      const label = items.find((i) => i.toLowerCase() === item) || item;
      orderProducts.set(label, (orderProducts.get(label) || 0) + 1);
    }
  }
  const orderBuyers = [];
  for (const o of weekOrders) {
    const name = o.businessName || o.contactName || o.id;
    if (!orderBuyers.includes(name)) orderBuyers.push(name);
  }

  const data = {
    week,
    range,
    priorWeek: prior,
    today,
    found: foundThisWeek.length,
    withPhone,
    noContact,
    byCity: countByNormalised(foundThisWeek, (l) => l.city, normaliseCity),
    bySegment: countBy(foundThisWeek, (l) => segmentLabel(l.segment)),
    registerTotal: buyerLeads.length,
    funnel: {
      new: buyerLeads.filter((l) => l.status === 'new').length,
      contacted: buyerLeads.filter((l) => l.status === 'contacted').length,
      quoted: buyerLeads.filter((l) => l.status === 'quoted').length,
      won: buyerLeads.filter((l) => l.status === 'won').length,
      lost: buyerLeads.filter((l) => l.status === 'lost').length,
      ignored: buyerLeads.filter((l) => l.status === 'ignored').length,
    },
    statusCounts: {
      contacted: statusCounts.contacted || 0,
      quoted: statusCounts.quoted || 0,
      won: statusCounts.won || 0,
      lost: statusCounts.lost || 0,
      ignored: statusCounts.ignored || 0,
    },
    wonNames,
    runs: weekRuns.length,
    runDays: [...runDays].sort(),
    daysWithoutRun,
    sources: [...sourceCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    blocked: [...blocked.entries()].map(([source, reason]) => ({ source, reason })),
    priceMoves,
    untouched,
    orders: {
      count: weekOrders.length,
      total: orders.length,
      byCity: countByNormalised(weekOrders, (o) => o.city, normaliseCity),
      byProduct: [...orderProducts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      buyers: orderBuyers,
      notDelivered: weekOrders.filter((o) => !(o.alert && ((o.alert.whatsapp && o.alert.whatsapp.sent) || (o.alert.email && o.alert.email.sent)))).length,
    },
  };
  data.nextActions = nextActions(data);
  return data;
}

/**
 * Three plain next actions, each one a statement of something the data already
 * says. A rule that is not true of this week's data produces no line, so the
 * report can hand back fewer than three rather than pad with advice.
 */
export function nextActions(d) {
  const out = [];
  const push = (s) => {
    if (s && out.length < 3) out.push(s);
  };

  const biggest = d.untouched[0];
  if (biggest && biggest.count >= 2) {
    push(`${biggest.count} ${plural(biggest.segment)} in ${biggest.city} untouched, all with a phone.`);
  }
  if (d.funnel.contacted > 0 && d.funnel.quoted === 0) {
    push(`${d.funnel.contacted} contacted, none quoted yet - send rates.`);
  }
  for (const b of d.blocked) {
    push(`${b.source} was blocked every run this week - that lane produced nothing.`);
  }
  if (d.daysWithoutRun.length > 0) {
    push(
      `No run on ${d.daysWithoutRun.length} of ${d.daysWithoutRun.length + d.runDays.length} days so far this week (${d.daysWithoutRun
        .map(shortDate)
        .slice(0, 3)
        .join(', ')}${d.daysWithoutRun.length > 3 ? ', ...' : ''}).`
    );
  }
  const move = d.priceMoves.find((p) => p.deltaPct !== null && Math.abs(p.deltaPct) >= 10);
  if (move) {
    push(
      `${move.label} modal ${move.deltaPct > 0 ? 'up' : 'down'} ${Math.abs(move.deltaPct)}% on last week - requote.`
    );
  }
  if (d.statusCounts.won > 0) {
    push(`${d.statusCounts.won} won this week - ask for the repeat order.`);
  }
  if (d.noContact > 0) {
    push(`${d.noContact} leads in the register have no phone, email or website.`);
  }
  const second = d.untouched[1];
  if (second && second.count >= 2) {
    push(`${second.count} ${plural(second.segment)} in ${second.city} untouched.`);
  }
  return out;
}

/** Blocked reasons are recorded in full; the text report shows the first line. */
function clipReason(reason, max = 110) {
  const t = String(reason || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

function priceLine(p) {
  const tail =
    p.lastWeek === null
      ? 'no reading last week'
      : `was ${p.lastWeek}${p.deltaPct === null ? '' : ` (${p.deltaPct > 0 ? '+' : ''}${p.deltaPct}%)`}`;
  return `${p.label}${p.approx ? ' ~' : ''} ${p.thisWeek}, ${tail}`;
}

/** WhatsApp-shaped plain text, hard-capped at REPORT.maxChars. */
export function renderReportText(d, { maxChars = REPORT.maxChars } = {}) {
  const build = (limits) => {
    const lines = [];
    lines.push(`${CLIENT.digest.title} - week ${d.week} (${shortDate(d.range.start)} - ${shortDate(d.range.end)})`);
    lines.push('');
    lines.push(`Leads found this week: ${d.found} (${d.withPhone} with a phone)`);
    if (d.byCity.length) lines.push(`City: ${topList(d.byCity, limits.cities)}`);
    if (d.bySegment.length) lines.push(`Segment: ${topList(d.bySegment, limits.segments)}`);
    lines.push('');
    lines.push(
      `Status changes: contacted ${d.statusCounts.contacted}, quoted ${d.statusCounts.quoted}, won ${d.statusCounts.won}, lost ${d.statusCounts.lost}`
    );
    lines.push(
      d.wonNames.length
        ? `Won: ${d.wonNames.slice(0, limits.won).join(', ')}${d.wonNames.length > limits.won ? `, +${d.wonNames.length - limits.won} more` : ''}`
        : 'Won: none this week'
    );
    lines.push(
      `Register: ${d.registerTotal} leads - new ${d.funnel.new}, contacted ${d.funnel.contacted}, quoted ${d.funnel.quoted}, won ${d.funnel.won}, lost ${d.funnel.lost}`
    );
    lines.push('');
    lines.push(`Orders on ${ORDER_SITE}: ${d.orders.count} this week (${d.orders.total} all time)`);
    if (d.orders.count) {
      if (d.orders.byCity.length) lines.push(`Order city: ${topList(d.orders.byCity, limits.cities)}`);
      if (limits.prices > 0 && d.orders.byProduct.length) lines.push(`Ordered: ${topList(d.orders.byProduct, limits.prices)}`);
      lines.push(
        `Ordered by: ${d.orders.buyers.slice(0, limits.won).join(', ')}${d.orders.buyers.length > limits.won ? `, +${d.orders.buyers.length - limits.won} more` : ''}`
      );
      if (d.orders.notDelivered) lines.push(`${d.orders.notDelivered} order alert${d.orders.notDelivered === 1 ? '' : 's'} did not reach the owner - see the Orders page`);
    }
    lines.push('');
    lines.push(
      `Runs: ${d.runs} on ${d.runDays.length} ${d.runDays.length === 1 ? 'day' : 'days'}`
    );
    lines.push(`Sources: ${topList(d.sources, 6)}`);
    lines.push(
      d.blocked.length
        ? `Blocked: ${d.blocked.map((b) => `${b.source} (${clipReason(b.reason)})`).join('; ')}`
        : 'Blocked: none'
    );
    if (limits.prices > 0) {
      lines.push('');
      lines.push('Mandi modal, INR/quintal (~ = nearest line):');
      if (d.priceMoves.length) {
        for (const p of d.priceMoves.slice(0, limits.prices)) lines.push(`  ${priceLine(p)}`);
        if (d.priceMoves.length > limits.prices) {
          lines.push(`  +${d.priceMoves.length - limits.prices} more items priced`);
        }
      } else {
        lines.push('  no mandi readings stored this week');
      }
    }
    if (d.nextActions.length) {
      lines.push('');
      lines.push('Next:');
      d.nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
    }
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  };

  // Widest set of limits that fits the cap, then progressively tighter.
  const ladder = [
    { cities: REPORT.topCities, segments: REPORT.topSegments, prices: REPORT.topPriceItems, won: REPORT.topWon },
    { cities: 4, segments: 5, prices: 5, won: 4 },
    { cities: 3, segments: 4, prices: 4, won: 3 },
    { cities: 2, segments: 3, prices: 3, won: 2 },
    { cities: 2, segments: 2, prices: 2, won: 1 },
    { cities: 1, segments: 1, prices: 0, won: 1 },
  ];
  for (const limits of ladder) {
    const text = build(limits);
    if (text.length <= maxChars) return text;
  }
  return build(ladder[ladder.length - 1]).slice(0, maxChars);
}

export function renderReportHtml(d) {
  const rows = (pairs) =>
    pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') ||
    '<tr><td colspan="2" class="muted">none</td></tr>';

  const body = `
<section>
  <h2>Week ${esc(d.week)} &middot; ${esc(shortDate(d.range.start))} to ${esc(shortDate(d.range.end))}</h2>
  <div class="tiles">
    <div class="tile"><div class="n">${d.found}</div><div class="k">found this week</div></div>
    <div class="tile"><div class="n">${d.withPhone}</div><div class="k">with a phone</div></div>
    <div class="tile"><div class="n">${d.runs}</div><div class="k">runs</div></div>
    <div class="tile"><div class="n">${d.registerTotal}</div><div class="k">in register</div></div>
  </div>
  <p class="muted">Counted from the store on ${esc(d.today)}. Price rows are not counted as leads.</p>
</section>

<section>
  <h2>Found this week</h2>
  <h3>By city</h3>
  <table><tbody>${rows(d.byCity)}</tbody></table>
  <h3>By segment</h3>
  <table><tbody>${rows(d.bySegment)}</tbody></table>
</section>

<section>
  <h2>Status changes this week</h2>
  <table><tbody>
    <tr><td>contacted</td><td class="num">${d.statusCounts.contacted}</td></tr>
    <tr><td>quoted</td><td class="num">${d.statusCounts.quoted}</td></tr>
    <tr><td>won</td><td class="num">${d.statusCounts.won}</td></tr>
    <tr><td>lost</td><td class="num">${d.statusCounts.lost}</td></tr>
    <tr><td>ignored</td><td class="num">${d.statusCounts.ignored}</td></tr>
  </tbody></table>
  <h3>Won</h3>
  <p>${d.wonNames.length ? esc(d.wonNames.join(', ')) : '<span class="muted">none this week</span>'}</p>
  <h3>Register now</h3>
  <p class="muted">new ${d.funnel.new} &middot; contacted ${d.funnel.contacted} &middot; quoted ${d.funnel.quoted} &middot; won ${d.funnel.won} &middot; lost ${d.funnel.lost} &middot; ignored ${d.funnel.ignored}</p>
</section>

<section>
  <h2>Orders</h2>
  <div class="tiles">
    <div class="tile"><div class="n">${d.orders.count}</div><div class="k">this week</div></div>
    <div class="tile"><div class="n">${d.orders.total}</div><div class="k">all time</div></div>
    <div class="tile"><div class="n">${d.orders.buyers.length}</div><div class="k">buyers who ordered</div></div>
    <div class="tile"><div class="n">${d.orders.notDelivered}</div><div class="k">alerts not delivered</div></div>
  </div>
  ${
    d.orders.count
      ? `<h3>By city</h3>
  <table><tbody>${rows(d.orders.byCity)}</tbody></table>
  <h3>By product</h3>
  <table><tbody>${rows(d.orders.byProduct)}</tbody></table>
  <h3>Buyers who ordered</h3>
  <p>${esc(d.orders.buyers.join(', '))}</p>`
      : `<p class="muted">No order came in from ${esc(ORDER_SITE)} this week.</p>`
  }
</section>

<section>
  <h2>Sources</h2>
  <table><tbody>${rows(d.sources)}</tbody></table>
  <h3>Blocked</h3>
  ${
    d.blocked.length
      ? `<ul>${d.blocked.map((b) => `<li class="blocked">${esc(b.source)} - ${esc(b.reason)}</li>`).join('')}</ul>`
      : '<p class="muted">none</p>'
  }
  ${
    d.daysWithoutRun.length
      ? `<p class="muted">No run on: ${esc(d.daysWithoutRun.join(', '))}</p>`
      : ''
  }
</section>

<section>
  <h2>Price movement</h2>
  ${
    d.priceMoves.length
      ? `<div class="scroll"><table>
  <thead><tr><th>Item</th><th class="num">This week</th><th class="num">Last week</th><th class="num">Change</th><th class="num">Readings</th></tr></thead>
  <tbody>${d.priceMoves
    .map(
      (p) => `<tr><td>${esc(p.label)}${p.approx ? ' <span class="muted">~</span>' : ''}</td>` +
        `<td class="num">${p.thisWeek}</td>` +
        `<td class="num">${p.lastWeek === null ? '<span class="muted">-</span>' : p.lastWeek}</td>` +
        `<td class="num">${p.deltaPct === null ? '<span class="muted">-</span>' : `${p.deltaPct > 0 ? '+' : ''}${p.deltaPct}%`}</td>` +
        `<td class="num">${p.readings}</td></tr>`
    )
    .join('')}</tbody></table></div>
  <p class="muted">Mean modal price across the mandis stored that week, INR per quintal. ~ = priced off the nearest Agmarknet line, not its own.</p>`
      : '<p class="muted">No mandi readings stored for this week.</p>'
  }
</section>

<section>
  <h2>Next</h2>
  ${
    d.nextActions.length
      ? `<ol>${d.nextActions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`
      : '<p class="muted">Nothing in this week\'s data produced an action.</p>'
  }
</section>
`;
  return page({
    title: `${CLIENT.digest.title} - week ${d.week}`,
    subtitle: `Week ${d.week} - ${shortDate(d.range.start)} to ${shortDate(d.range.end)}`,
    active: '/report/weekly',
    body,
  });
}

/** Read the store, collect and render. Returns the data and both renderings. */
export async function buildReport({ week = isoWeek(new Date()), today = todayIso(), store } = {}) {
  const own = !store;
  const s = store || (await openStore());
  try {
    const leads = await s.allLeads();
    const runs = await s.allRuns();
    const events = typeof s.allEvents === 'function' ? await s.allEvents() : [];
    const orders = typeof s.allOrders === 'function' ? await s.allOrders() : [];
    const data = collectReport({ leads, runs, events, orders, week, today });
    return { data, text: renderReportText(data), html: renderReportHtml(data) };
  } finally {
    if (own) await s.close();
  }
}

export async function writeReport(week, { text, html }, { dir = REPORTS_DIR } = {}) {
  await mkdir(dir, { recursive: true });
  const txt = path.join(dir, `${week}.txt`);
  const htmlFile = path.join(dir, `${week}.html`);
  await writeFile(txt, text, 'utf8');
  await writeFile(htmlFile, html, 'utf8');
  return { txt, html: htmlFile };
}

export function parseArgs(argv) {
  const out = { week: isoWeek(new Date()) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--week') out.week = String(argv[++i] || '');
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  weekRange(out.week); // throws on a week that does not exist
  return out;
}

const USAGE = `
Buyer Radar - weekly report

  node src/report.mjs [--week 2026-W37]

Defaults to the current ISO week. Writes reports/<week>.txt and reports/<week>.html.
Every number is counted from the store. This command never sends anything.
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    process.exit(2);
    return;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const built = await buildReport({ week: opts.week });
  const files = await writeReport(opts.week, built);
  process.stdout.write(built.text);
  process.stderr.write(
    `\n[report] ${opts.week} ${built.text.length} chars -> ${path.relative(ROOT, files.txt)} and ${path.relative(ROOT, files.html)}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
