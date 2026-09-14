import { BASE } from './base.mjs';
// Page bodies. Each function takes data that has already been read and returns
// HTML. Nothing here touches the store, the clock or the network, so every page
// can be rendered in a test from a fixture.

import { page, esc, sparkline } from './layout.mjs';
import { segmentLabel, STATUSES, SEGMENTS, KINDS } from '../lib/normalise.mjs';
import { describeSegment } from '../model.mjs';
import { shortDate } from '../lib/week.mjs';

const STATUS_BUTTONS = ['contacted', 'quoted', 'won', 'lost', 'ignored'];

function tile(n, k) {
  return `<div class="tile"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`;
}

function flash(message, kind) {
  if (!message) return '';
  return `<div class="flash${kind === 'bad' ? ' bad' : ''}">${esc(message)}</div>`;
}

// ------------------------------------------------------------------ today

/** "Window open until ..." - the 24 hours after an inbound WhatsApp message. */
function windowBanner(windowOpen) {
  if (!windowOpen) return '';
  const until = String(windowOpen.until).slice(11, 16);
  const day = String(windowOpen.until).slice(0, 10);
  return `<p class="muted">WhatsApp window open until ${esc(`${until} UTC on ${day}`)} - a free-form reply can be sent until then; after that only an approved template.</p>`;
}

export function todayPage({ date, digestText, priceSheet, counts, funnel, windowOpen = null, message, messageKind }) {
  const body = `
${flash(message, messageKind)}
<section>
  <h2>${esc(date)}</h2>
  <div class="tiles">
    ${tile(counts.total, 'leads')}
    ${tile(counts.newToday, 'found today')}
    ${tile(counts.withPhone, 'with a phone')}
    ${tile(counts.prices, 'price rows')}
  </div>
  <p class="muted">Requirements posted: ${esc(counts.requirements ?? 0)} (${esc(counts.requirementsWithContact ?? 0)} with contact)${
    counts.registrations ? ` &middot; ${esc(counts.registrations)} registration routes` : ''
  } &middot; <a href="${BASE}/leads?kind=requirement">see them</a></p>
  <div class="tiles">
    ${tile(funnel.new, 'new')}
    ${tile(funnel.contacted, 'contacted')}
    ${tile(funnel.quoted, 'quoted')}
    ${tile(funnel.won, 'won')}
    ${tile(funnel.lost, 'lost')}
  </div>
  ${windowBanner(windowOpen)}
</section>

<section>
  <h2>Digest</h2>
  ${
    digestText
      ? `<pre class="plain">${esc(digestText)}</pre><p class="muted">Written by the last run. Use the Register tab to change a status.</p>`
      : '<p class="muted">No digest file yet. Run the pipeline to write one.</p>'
  }
</section>

<section>
  <h2>Price sheet</h2>
  ${
    priceSheet
      ? `<pre class="plain">${esc(priceSheet)}</pre>`
      : '<p class="muted">No price sheet yet. Mandi prices need DATA_GOV_IN_KEY; without it nothing is stored and nothing is guessed.</p>'
  }
</section>
`;
  return page({ title: `Radar - ${date}`, subtitle: `Today - ${date}`, active: '/', body });
}

// ------------------------------------------------------------------ leads

function contactLinks(lead) {
  const bits = [];
  if (lead.phone) bits.push(`<a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>`);
  if (lead.email) bits.push(`<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>`);
  if (lead.website) {
    bits.push(
      `<a href="${esc(lead.website)}" rel="noreferrer noopener nofollow" target="_blank">${esc(
        lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '')
      )}</a>`
    );
  }
  return bits.length ? bits.join('') : '<span class="muted">no contact on the listing</span>';
}

/**
 * What the model read off this lead's own page, shown as what it is: a second
 * opinion with its quotes attached. The confidence is printed next to it, and
 * whether that was enough for the score to use it, so a disagreement is visible
 * rather than silently applied.
 */
function modelBlock(lead) {
  const llm = (lead.extra && lead.extra.llm) || null;
  if (!llm) return '';
  const used = typeof llm.confidence === 'number' && llm.confidence >= 0.7;
  const facts = [
    lead.segment_model ? `reads as ${segmentLabel(lead.segment_model)}` : null,
    llm.size && llm.size !== 'unknown' ? `size ${llm.size}` : null,
    llm.deadline ? `deadline ${llm.deadline}` : null,
    llm.quantity ? `requirement ${llm.quantity}` : null,
    llm.buys && llm.buys.length ? `buys ${llm.buys.join(', ')}` : null,
  ].filter(Boolean);
  return `
  <div class="model">
    <div class="meta">
      <span class="pill${used ? ' on' : ''}">model ${esc(llm.confidence)}</span>
      <span class="muted">${esc(
        used
          ? lead.segment_model === lead.segment_source
            ? 'agrees with the source; used in the score'
            : `source said ${segmentLabel(lead.segment_source || lead.segment)}; the score uses the model`
          : 'below 0.7 confidence, so the score ignores it'
      )}</span>
    </div>
    ${facts.length ? `<div class="why">${esc(facts.join(' - '))}</div>` : ''}
    ${
      llm.evidence && llm.evidence.length
        ? `<ul class="evidence">${llm.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : '<div class="muted">no quotes returned</div>'
    }
    ${lead.opener_model ? `<pre class="plain">${esc(lead.opener_model)}</pre>` : ''}
  </div>`;
}

/**
 * What a posted requirement says, on its own line.
 *
 * This is the block the owner reads before he decides to ring: what they need,
 * how much, by when, who to ask for, and the document that says so. A field the
 * notice did not state is printed as not stated, never left to look like a zero.
 */
function requirementBlock(lead) {
  if (lead.kind !== 'requirement' && lead.kind !== 'registration') return '';
  const e = lead.extra || {};
  const rows = [
    ['needs', e.requirement],
    ['quantity', e.quantity || (lead.kind === 'requirement' ? 'not stated in the notice' : null)],
    ['closes', e.deadline || (lead.kind === 'requirement' ? 'no closing date stated' : null)],
    ['ask for', e.contact_name],
    ['how to register', e.how],
  ].filter(([, v]) => v);
  const contact = e.contact_phone || e.contact_email || lead.phone || lead.email;
  const doc = e.document_url || lead.source_url;
  return `
  <div class="model">
    <div class="meta">
      <span class="pill on">${esc(lead.kind === 'requirement' ? 'requirement posted' : 'registration route')}</span>
      ${e.quantityFit ? `<span class="pill">fit: ${esc(e.quantityFit)}</span>` : ''}
      ${contact ? '' : '<span class="pill">contact not found yet</span>'}
    </div>
    ${rows.map(([k, v]) => `<div class="why">${esc(k)}: ${esc(v)}</div>`).join('')}
    ${e.unreadable ? `<div class="blocked">${esc(`the document could not be read as text: ${e.unreadable}`)}</div>` : ''}
    ${
      doc
        ? `<div class="contact"><a href="${esc(doc)}" rel="noreferrer noopener nofollow" target="_blank">${esc(
            String(doc).replace(/^https?:\/\//, '').slice(0, 80)
          )}</a></div>`
        : ''
    }
  </div>`;
}

function leadBlock(lead, query) {
  return `
<div class="lead">
  <div class="nm">${esc(lead.name)}</div>
  <div class="meta">
    <span class="pill${lead.kind === 'requirement' ? ' on' : ''}">${esc(lead.kind === 'requirement' ? 'requirement' : describeSegment(lead))}</span>
    <span class="pill">${esc(lead.city || 'no city')}</span>
    <span class="pill">${esc(lead.source)}</span>
    <span class="pill${lead.status !== 'new' ? ' on' : ''}">${esc(lead.status)}</span>
    <span class="pill">score ${esc(lead.score)}</span>
  </div>
  ${lead.why_now ? `<div class="why">${esc(lead.why_now)}</div>` : ''}
  <div class="contact">${contactLinks(lead)}</div>
  ${requirementBlock(lead)}
  ${modelBlock(lead)}
  ${lead.notes ? `<div class="note">${esc(lead.notes)}</div>` : ''}
  <form class="status" method="post" action="${BASE}/leads/${esc(lead.id)}/status">
    <input type="hidden" name="back" value="${esc(query)}">
    <input type="text" name="note" placeholder="note (optional)" maxlength="240" autocomplete="off">
    ${STATUS_BUTTONS.map(
      (s) =>
        `<button type="submit" name="status" value="${esc(s)}"${
          s === lead.status ? ' class="ghost"' : ''
        }>${esc(s)}</button>`
    ).join('')}
  </form>
</div>`;
}

export function leadsPage({ leads, total, filters, cities, sources, query, message, messageKind, limit }) {
  const option = (value, current, text) =>
    `<option value="${esc(value)}"${String(current || '') === String(value) ? ' selected' : ''}>${esc(text)}</option>`;

  const body = `
${flash(message, messageKind)}
<section>
  <h2>Filter</h2>
  <form class="filters" method="get" action="${BASE}/leads">
    <label>Kind
      <select name="kind">
        ${option('', filters.kind, 'any')}
        ${KINDS.filter((k) => k !== 'price').map((k) => option(k, filters.kind, k === 'requirement' ? 'Requirements' : k)).join('')}
      </select>
    </label>
    <label>Status
      <select name="status">
        ${option('', filters.status, 'any')}
        ${STATUSES.map((s) => option(s, filters.status, s)).join('')}
      </select>
    </label>
    <label>Segment
      <select name="segment">
        ${option('', filters.segment, 'any')}
        ${SEGMENTS.map((s) => option(s, filters.segment, segmentLabel(s))).join('')}
      </select>
    </label>
    <label>City
      <select name="city">
        ${option('', filters.city, 'any')}
        ${cities.map((c) => option(c, filters.city, c)).join('')}
      </select>
    </label>
    <label>Source
      <select name="source">
        ${option('', filters.source, 'any')}
        ${sources.map((s) => option(s, filters.source, s)).join('')}
      </select>
    </label>
    <label>Name or phone
      <input type="search" name="q" value="${esc(filters.q || '')}" placeholder="search" autocomplete="off">
    </label>
    <button type="submit">Apply</button>
    <a href="${BASE}/leads"><button type="button" class="ghost">Clear</button></a>
  </form>
</section>

<section>
  <h2>${leads.length} shown of ${total} matching</h2>
  <p class="muted">Ordered by score. <a href="${BASE}/export.csv${query ? `?${query}` : ''}">Download CSV of these ${total}</a>${
    total > leads.length ? ` &middot; showing the first ${limit}` : ''
  }</p>
  ${leads.length ? leads.map((l) => leadBlock(l, query)).join('') : '<p class="muted">Nothing matches this filter.</p>'}
</section>
`;
  return page({ title: 'Radar - register', subtitle: `Register - ${total} matching`, active: '/leads', body });
}

// ------------------------------------------------------------------ orders

/**
 * Orders that came in from the client's own site. One row per order, newest
 * first, and the last column is the honest one: whether the owner was told, and
 * by which channel. A row that says "not delivered" is a row the owner has to
 * chase, and the page says so rather than showing a tick.
 */
export function ordersPage({ orders, total, limit, message, messageKind }) {
  const rows = orders
    .map(
      (o) => `<tr>
  <td>${esc(o.date)}</td>
  <td><code>${esc(o.id)}</code></td>
  <td>${esc(o.buyer)}${o.leadId ? ` <a class="muted" href="${BASE}/leads?q=${encodeURIComponent(o.buyer)}">register</a>` : ''}</td>
  <td>${esc(o.businessType || '-')}</td>
  <td>${esc(o.city || '-')}</td>
  <td>${o.lines.length ? o.lines.map((l) => esc(l)).join('<br>') : '<span class="muted">-</span>'}</td>
  <td>${esc(o.alert)}</td>
</tr>`
    )
    .join('');

  const body = `
${flash(message, messageKind)}
<section>
  <div class="tiles">
    ${tile(total, total === 1 ? 'order' : 'orders')}
    ${tile(orders.filter((o) => o.alert === 'WhatsApp sent').length, 'told on WhatsApp')}
    ${tile(orders.filter((o) => o.alert.startsWith('email')).length, 'told by email')}
    ${tile(orders.filter((o) => o.alert.startsWith('not ')).length, 'not delivered')}
  </div>
  <p class="muted">Every order the site has sent the radar, newest first. <a href="${BASE}/orders.csv">Download CSV</a>${
    total > orders.length ? ` &middot; showing the first ${limit}` : ''
  }</p>
</section>

<section>
  <h2>Orders</h2>
  ${
    rows
      ? `<div class="scroll"><table>
  <thead><tr><th>Date</th><th>Reference</th><th>Buyer</th><th>Business</th><th>City</th><th>Lines</th><th>Owner alert</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="muted">The buyer is never messaged from here. The only alert this page reports is the one sent to the owner's own number or address.</p>`
      : '<p class="muted">No order has reached the radar yet. The site posts one here as soon as a buyer places it.</p>'
  }
</section>
`;
  return page({ title: 'Radar - orders', subtitle: `Orders - ${total}`, active: '/orders', body });
}

// ------------------------------------------------------------------ prices

export function pricesPage({ days, rows, unpriced }) {
  const head = days.map((d) => `<th class="num">${esc(shortDate(d))}</th>`).join('');
  const body = `
<section>
  <h2>Modal price, last ${days.length} days</h2>
  <p class="muted">INR per quintal, from the mandi rows stored by the agmarknet source. A blank cell means no reading was stored that day - it is not a zero and it is not carried over. ~ = priced off the nearest Agmarknet line, not its own.</p>
  ${
    rows.length
      ? `<div class="scroll"><table>
    <thead><tr><th>Item</th><th>Trend</th>${head}</tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <td>${esc(r.label)}${r.approx ? ' <span class="muted">~</span>' : ''}<div class="muted">${esc(r.commodity)}</div></td>
      <td>${sparkline(r.series) || '<span class="muted">one reading</span>'}</td>
      ${r.series
        .map((v) => `<td class="num">${v === null ? '<span class="muted">-</span>' : esc(v)}</td>`)
        .join('')}
    </tr>`
      )
      .join('')}</tbody>
  </table></div>`
      : '<p class="muted">No mandi readings stored. The agmarknet source needs DATA_GOV_IN_KEY; without it prices are absent, never invented.</p>'
  }
</section>

<section>
  <h2>No mandi line</h2>
  <p class="muted">Agmarknet publishes no price for these catalogue items, so the price sheet says so rather than guessing.</p>
  <p>${unpriced.length ? esc(unpriced.join(', ')) : '<span class="muted">none</span>'}</p>
</section>
`;
  return page({ title: 'Radar - prices', subtitle: 'Mandi price history', active: '/prices', body });
}

// ------------------------------------------------------------------ runs

/** What the WhatsApp webhook received, per day, and the last thing that failed. */
function webhookSection(webhook) {
  if (!webhook) return '';
  const { days = [], lastFailure = null } = webhook;
  return `
<section>
  <h2>Webhook</h2>
  ${
    days.length
      ? `<div class="scroll"><table>
  <thead><tr><th>Day</th><th class="num">Inbound</th><th class="num">Statuses</th><th class="num">Duplicates</th><th class="num">Rejected</th><th>Last event</th></tr></thead>
  <tbody>${days
    .map(
      (d) => `<tr>
    <td>${esc(d.day)}</td>
    <td class="num">${esc(d.inbound)}</td>
    <td class="num">${esc(d.statuses)}</td>
    <td class="num">${esc(d.duplicates)}</td>
    <td class="num">${esc(d.rejected)}</td>
    <td>${esc(d.lastAt || '-')}</td>
  </tr>`
    )
    .join('')}</tbody></table></div>`
      : '<p class="muted">No WhatsApp event has arrived yet.</p>'
  }
  ${lastFailure ? `<p class="blocked">Last failure: ${esc(lastFailure.line)}</p>` : '<p class="muted">No failed delivery and no rejected event recorded.</p>'}
  <p class="muted">Receipts for these are in <code>runs/webhook_&lt;date&gt;.evidence.json</code>, verified the same way as a run bundle.</p>
</section>`;
}

/**
 * What the model stage cost this run, and what it decided not to spend.
 *
 * Four numbers, always in the same order: calls made, calls the "model only
 * when needed" rules refused, answers served free from the cache, and calls the
 * daily cap stopped. A run with the stage off says so and why. Nothing here is
 * rounded into looking cheaper than it was.
 */
function llmCell(llm) {
  if (!llm) return '<span class="muted">-</span>';
  if (!llm.enabled) return `<span class="muted">off${llm.reason ? ` - ${esc(llm.reason)}` : ''}</span>`;
  const bits = [
    `${esc(llm.calls ?? 0)} calls`,
    `${esc(llm.notNeeded ?? 0)} not needed`,
    `${esc(llm.cacheHits ?? 0)} cache hits`,
    `${esc(llm.budgetSkipped ?? 0)} budget skips`,
    `Rs ${esc(llm.costInr ?? 0)}`,
  ];
  const trouble = [];
  if (llm.invalid) trouble.push(`${llm.invalid} unreadable`);
  if (llm.errors) trouble.push(`${llm.errors} errors`);
  return `${bits.join(' &middot; ')}<div class="muted">${esc(llm.enriched ?? 0)} enriched, ${esc(llm.openers ?? 0)} openers</div>${
    trouble.length ? `<div class="blocked">${esc(trouble.join(', '))}</div>` : ''
  }`;
}

/**
 * What the openings lane read, and what it decided not to read.
 *
 * The three numbers that matter are articles read, signals kept as awareness
 * without a fetch or a model call, and whether the per-run cap stopped the
 * lane. A lane that read nothing because everything was an opening story should
 * say so here rather than look idle.
 */
function openingsCell(openings) {
  if (!openings) return '<span class="muted">-</span>';
  if (openings.skipped) return `<span class="muted">${esc(openings.skipped)}</span>`;
  const bits = [
    `${esc(openings.articlesRead ?? 0)} articles read`,
    `${esc(openings.awarenessOnly ?? 0)} awareness-only`,
    `cap ${esc(openings.readCap ?? '-')}`,
  ];
  return `${bits.join(' &middot; ')}<div class="muted">${esc(openings.requirementCandidates ?? 0)} requirement candidates of ${esc(
    openings.considered ?? 0
  )} signals, ${esc(openings.upgraded ?? 0)} upgraded</div>${
    openings.capReached
      ? `<div class="blocked">cap reached - ${esc(openings.cappedOut ?? 0)} candidates left unread</div>`
      : ''
  }`;
}

export function runsPage({ runs, webhook = null }) {
  const body = `
<section>
  <h2>${runs.length} runs</h2>
  ${
    runs.length
      ? `<div class="scroll"><table>
  <thead><tr><th>Run</th><th>City</th><th>Sources</th><th class="num">Candidates</th><th class="num">Leads</th><th>Model</th><th>Openings</th><th>Bundle</th></tr></thead>
  <tbody>${runs
    .map(
      (r) => `<tr>
    <td>${esc(r.id)}<div class="muted">${esc(r.startedAt || '')}</div></td>
    <td>${esc(r.city || '-')}</td>
    <td>${esc((r.sources || []).join(', '))}
      ${
        (r.blocked || []).length
          ? `<div class="blocked">blocked: ${esc(r.blocked.map((b) => b.source).join(', '))}</div>`
          : ''
      }
    </td>
    <td class="num">${esc(r.candidates ?? '-')}</td>
    <td class="num">${esc(r.leadsTotal ?? '-')}</td>
    <td>${llmCell(r.llm)}</td>
    <td>${openingsCell(r.openings)}</td>
    <td><code class="muted">${esc(String(r.bundleHash || '').slice(0, 12))}</code>${
      r.hasBundle ? `<div><a href="${BASE}/runs/${esc(r.id)}/evidence.json">evidence</a></div>` : ''
    }</td>
  </tr>`
    )
    .join('')}</tbody></table></div>`
      : '<p class="muted">No runs recorded yet.</p>'
  }
  <p class="muted">Verify a downloaded bundle with <code>node tools/verify.mjs runs/&lt;runId&gt;.evidence.json</code>.</p>
</section>

${webhookSection(webhook)}

${
  runs.some((r) => (r.blocked || []).length)
    ? `<section><h2>Blocked sources</h2><ul>${runs
        .flatMap((r) => (r.blocked || []).map((b) => `<li class="blocked"><b>${esc(b.source)}</b> in ${esc(r.id)} - ${esc(b.reason)}</li>`))
        .join('')}</ul></section>`
    : ''
}
`;
  return page({ title: 'Radar - runs', subtitle: `${runs.length} runs`, active: '/runs', body });
}

// ------------------------------------------------------------------ login

export function loginPage({ reason = 'This dashboard needs the owner token.' } = {}) {
  return page({
    title: 'Radar - sign in',
    subtitle: 'Sign in',
    chrome: false,
    body: `<section>
  <h2>Owner only</h2>
  <p>${esc(reason)}</p>
  <p class="muted">Open <code>/login?t=&lt;token&gt;</code> once with the value of <code>RADAR_OWNER_TOKEN</code>. The browser then keeps it in a cookie. An API client can send <code>Authorization: Bearer &lt;token&gt;</code> instead.</p>
</section>`,
  });
}

export function notFoundPage(pathname) {
  return page({
    title: 'Radar - not found',
    subtitle: 'Not found',
    active: null,
    body: `<section><h2>Not found</h2><p class="muted">${esc(pathname)}</p><p><a href="${BASE}/">Back to today</a></p></section>`,
  });
}
