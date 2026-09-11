import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, parseCookies, presentedToken, priceSeries, COOKIE_NAME } from '../src/dashboard/server.mjs';
import { fixtureStore, LEADS } from './fixtures/store.mjs';
import { verifyBundle } from '../src/lib/receipts.mjs';

const TOKEN = 'test-owner-token-0123456789';

/** Start the dashboard on an ephemeral port over a fixture store. */
async function withServer(t, { store = fixtureStore() } = {}) {
  const digestsDir = await mkdtemp(path.join(tmpdir(), 'radar-digests-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-runs-'));
  await writeFile(path.join(digestsDir, '2026-09-10.txt'), `${CLIENT.digest.title} - 2026-09-10\n\nL1 Copper Chimney\n`);
  await writeFile(path.join(digestsDir, '2026-09-10.prices.txt'), 'Mandi price sheet - 2026-09-10\nPeeled garlic: Rs 14000/qtl\n');
  await writeFile(path.join(runsDir, 'run_20260909_aaaaaaaa.evidence.json'), JSON.stringify({ schema: 'x', receipts: [] }));

  const server = createServer({ token: TOKEN, digestsDir, runsDir, storeFactory: async () => store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const get = (p, { headers = {}, method = 'GET', body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: p, method, headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  const auth = (p, opts = {}) =>
    get(p, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });

  return { get, auth, store, digestsDir, runsDir, port };
}

const PAGES = ['/', '/leads', '/prices', '/runs', '/report/weekly', '/export.csv'];

test('createServer refuses to start without a token', () => {
  assert.throws(() => createServer({ token: '' }), /RADAR_OWNER_TOKEN is not set/);
  assert.throws(() => createServer({ token: 'short' }), /shorter than 8 characters/);
});

test('every page is 401 without a token', async (t) => {
  const { get } = await withServer(t);
  for (const p of PAGES) {
    const res = await get(p);
    assert.equal(res.status, 401, `${p} without a token`);
    assert.match(res.headers['www-authenticate'] || '', /Bearer/);
    assert.ok(!res.text.includes('Copper Chimney'), `${p} leaked data in the 401 body`);
  }
});

test('a wrong token, a truncated token and a longer token are all 401', async (t) => {
  const { get } = await withServer(t);
  for (const bad of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`, '']) {
    const res = await get('/', { headers: { Authorization: `Bearer ${bad}` } });
    assert.equal(res.status, 401, `token ${JSON.stringify(bad)}`);
  }
  assert.equal((await get(`/login?t=${TOKEN}wrong`)).status, 401);
});

test('every page is 200 with the bearer token', async (t) => {
  const { auth } = await withServer(t);
  for (const p of PAGES) {
    const res = await auth(p);
    assert.equal(res.status, 200, `${p} with a token`);
  }
});

test('/login sets an HttpOnly SameSite cookie and the cookie then authenticates', async (t) => {
  const { get } = await withServer(t);
  const login = await get(`/login?t=${TOKEN}`);
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/');
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^radar_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const withCookie = await get('/', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(withCookie.status, 200);
});

test('the today page shows the latest digest, the price sheet and the funnel', async (t) => {
  const { auth } = await withServer(t);
  const res = await auth('/');
  assert.match(res.text, new RegExp(`${CLIENT.digest.title} - 2026-09-10`));
  assert.match(res.text, /Peeled garlic: Rs 14000\/qtl/);
  assert.match(res.text, /<div class="k">with a phone<\/div>/);
  // 9 buyer leads in the fixture, price rows are not counted as leads.
  assert.match(res.text, /<div class="n">9<\/div><div class="k">leads<\/div>/);
});

test('the register lists leads with a tel: link and a status form', async (t) => {
  const { auth } = await withServer(t);
  const res = await auth('/leads');
  assert.match(res.text, /href="tel:\+919845000002"/);
  assert.match(res.text, /<form class="status" method="post" action="\/leads\/[a-f0-9]+\/status">/);
  for (const s of ['contacted', 'quoted', 'won', 'lost', 'ignored']) {
    assert.match(res.text, new RegExp(`name="status" value="${s}"`));
  }
  assert.match(res.text, /no contact on the listing/, 'a lead with no contact says so');
});

test('the register filters by status, segment, city, source and a search', async (t) => {
  const { auth } = await withServer(t);
  const count = async (q) => {
    const res = await auth(`/leads${q}`);
    assert.equal(res.status, 200);
    return Number(res.text.match(/<h2>(\d+) shown of (\d+) matching<\/h2>/)[2]);
  };
  assert.equal(await count(''), 9);
  assert.equal(await count('?status=new'), 7);
  assert.equal(await count('?status=won'), 1);
  assert.equal(await count('?segment=hotel'), 4);
  assert.equal(await count('?city=Chennai'), 2);
  assert.equal(await count('?segment=hotel&city=Chennai'), 2);
  assert.equal(await count('?source=overpass'), 9);
  assert.equal(await count('?source=news'), 0);
  assert.equal(await count('?q=Chennai%20Grand'), 1);
  assert.equal(await count('?q=9845000003'), 1, 'search matches on digits of the phone');
  assert.equal(await count('?q=nothing%20matches%20this'), 0);
});

test('a hostile trading name cannot inject markup into the register', async (t) => {
  const store = fixtureStore({
    leads: [{ ...LEADS[0], id: 'evil', name: '<img src=x onerror=alert(1)>' }],
  });
  const { auth } = await withServer(t, { store });
  const res = await auth('/leads');
  assert.ok(!res.text.includes('<img src=x onerror=alert(1)>'));
  assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a status change posted from the dashboard writes through the register API', async (t) => {
  const store = fixtureStore();
  const { auth, runsDir } = await withServer(t, { store });
  const target = (await store.allLeads()).find((l) => l.name === 'Copper Chimney');
  assert.equal(target.status, 'new');

  const body = new URLSearchParams({ status: 'contacted', note: 'spoke to the purchase manager', back: 'status=new' }).toString();
  const res = await auth(`/leads/${target.id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/leads\?status=new&m=/);

  const after = await store.getLead(target.id);
  assert.equal(after.status, 'contacted');
  assert.match(after.notes, /contacted: spoke to the purchase manager$/m);

  // The same receipt and event the CLI would have written.
  const files = (await readdir(runsDir)).filter((f) => f.startsWith('status_'));
  assert.equal(files.length, 1);
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true, 'the receipt bundle verifies');
  assert.equal(bundle.receipts[0].type, 'lead.status_changed');
  assert.equal(bundle.receipts[0].to, 'contacted');
  const events = await store.allEvents();
  assert.ok(events.some((e) => e.type === 'lead.status_changed' && e.leadId === target.id && e.to === 'contacted'));
});

test('an unknown status is refused and changes nothing', async (t) => {
  const store = fixtureStore();
  const { auth } = await withServer(t, { store });
  const target = (await store.allLeads())[0];
  const body = 'status=banana';
  const res = await auth(`/leads/${target.id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
    body,
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /e=unknown%20status/);
  assert.equal((await store.getLead(target.id)).status, 'new');
});

test('a status change without the token, or from another origin, is refused', async (t) => {
  const store = fixtureStore();
  const { get, auth } = await withServer(t, { store });
  const target = (await store.allLeads())[0];
  const body = 'status=won';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length };

  const noToken = await get(`/leads/${target.id}/status`, { method: 'POST', headers, body });
  assert.equal(noToken.status, 401);

  const crossOrigin = await auth(`/leads/${target.id}/status`, {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.example' },
    body,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await store.getLead(target.id)).status, 'new');
});

test('the prices page shows a row per priced item and names the ones with no mandi line', async (t) => {
  // The page always shows the last 14 days ending today, so the fixture prices
  // are dated relative to the real clock - otherwise this test would quietly
  // stop exercising anything a fortnight from now.
  const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  const priceRow = (id, commodity, date, modal) => ({
    ...LEADS[0],
    id,
    kind: 'price',
    name: `${commodity} - Bengaluru APMC`,
    extra: { commodity, market: 'Bengaluru APMC', whyNowDate: date, modalPrice: modal },
  });
  const store = fixtureStore({
    leads: [
      priceRow('p1', 'Garlic', day(2), 14000),
      priceRow('p2', 'Garlic', day(0), 15000),
    ],
  });
  const { auth } = await withServer(t, { store });
  const res = await auth('/prices');
  assert.match(res.text, /Peeled garlic/);
  assert.match(res.text, /Broccoli/, 'an item Agmarknet does not price is still named');
  assert.match(res.text, /No mandi line/);
  assert.match(res.text, /14000/);
  assert.match(res.text, /15000/);
  assert.match(res.text, /<svg class="spark"/, 'two readings draw a sparkline');
});

test('priceSeries leaves a day with no reading null rather than carrying one over', () => {
  const priceLeads = [
    { kind: 'price', extra: { commodity: 'Garlic', whyNowDate: '2026-09-09', modalPrice: 14000 } },
    { kind: 'price', extra: { commodity: 'Garlic', whyNowDate: '2026-09-11', modalPrice: 15000 } },
    { kind: 'price', extra: { commodity: 'Garlic', whyNowDate: '2026-09-11', modalPrice: 13000 } },
  ];
  const { rows, unpriced } = priceSeries(priceLeads, ['2026-09-09', '2026-09-10', '2026-09-11']);
  const garlic = rows.find((r) => r.commodity === 'Garlic');
  assert.deepEqual(garlic.series, [14000, null, 14000]); // day 3 is the mean of two markets
  assert.ok(unpriced.includes('Broccoli'));
});

test('the runs page lists runs, blocked sources and an evidence link', async (t) => {
  const { auth } = await withServer(t);
  const res = await auth('/runs');
  assert.match(res.text, /run_20260909_aaaaaaaa/);
  assert.match(res.text, /run_20260910_bbbbbbbb/);
  assert.match(res.text, /blocked: cppp/);
  assert.match(res.text, /href="\/runs\/run_20260909_aaaaaaaa\/evidence\.json"/);
  // The run with no bundle file on disk gets no link.
  assert.ok(!res.text.includes('/runs/run_20260910_bbbbbbbb/evidence.json'));
});

test('an evidence bundle downloads, and a path traversal does not', async (t) => {
  const { auth } = await withServer(t);
  const ok = await auth('/runs/run_20260909_aaaaaaaa/evidence.json');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /application\/json/);
  assert.match(ok.headers['content-disposition'], /attachment/);
  for (const bad of ['/runs/..%2f..%2fetc%2fpasswd/evidence.json', '/runs/%2e%2e/evidence.json', '/runs/nope/evidence.json']) {
    assert.equal((await auth(bad)).status, 404, bad);
  }
});

test('the CSV export carries the filtered rows and a download header', async (t) => {
  const { auth } = await withServer(t);
  const all = await auth('/export.csv');
  assert.match(all.headers['content-type'], /text\/csv/);
  assert.match(all.headers['content-disposition'], /attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(all.text.trim().split('\n').length, 10); // header + 9 buyer leads
  const filtered = await auth('/export.csv?city=Chennai');
  assert.equal(filtered.text.trim().split('\n').length, 3);
  assert.match(filtered.text.split('\n')[0], /^id,kind,segment,name/);
});

test('the weekly report renders inside the dashboard chrome', async (t) => {
  const { auth } = await withServer(t);
  const res = await auth('/report/weekly?week=2026-W37');
  assert.equal(res.status, 200);
  assert.match(res.text, /Week 2026-W37/);
  assert.match(res.text, /Anand Caterers/);
  assert.match(res.text, /<nav class="tabs">/);
});

test('every response carries no-store and a restrictive CSP, and no page links out to a CDN', async (t) => {
  const { auth } = await withServer(t);
  for (const p of PAGES) {
    const res = await auth(p);
    assert.equal(res.headers['cache-control'], 'no-store', p);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', p);
    if (p === '/export.csv') continue;
    assert.match(res.headers['content-security-policy'], /default-src 'none'/, p);
    assert.ok(!/<script/i.test(res.text), `${p} contains a script tag`);
    assert.ok(!/https?:\/\/(cdn|unpkg|fonts\.google)/i.test(res.text), `${p} references an external asset`);
  }
});

test('an unknown route is 404 and a non-GET is 405', async (t) => {
  const { auth } = await withServer(t);
  assert.equal((await auth('/nope')).status, 404);
  assert.equal((await auth('/leads', { method: 'DELETE' })).status, 405);
});

test('parseCookies and presentedToken read both ways of presenting the token', () => {
  assert.deepEqual(parseCookies('a=1; radar_token=abc%20def; b=2'), { a: '1', radar_token: 'abc def', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(presentedToken({ headers: { authorization: 'Bearer xyz' } }), 'xyz');
  assert.equal(presentedToken({ headers: { cookie: `${COOKIE_NAME}=cookie-value` } }), 'cookie-value');
  assert.equal(presentedToken({ headers: {} }), null);
});

test('the register shows what the model read, its quotes, and whether the score used it', async (t) => {
  const used = { ...LEADS[0], id: 'llm000000000001', name: 'Model Used Ltd', segment: 'restaurant', segment_source: 'restaurant', segment_model: 'hotel', opener_model: 'Saw you run two kitchens.\nWe supply peeled garlic daily - can I send rates?', extra: { ...LEADS[0].extra, llm: { segment: 'hotel', size: 'large', buys: ['vegetables'], quantity: null, deadline: null, evidence: ['<script>alert(1)</script> we run 120 rooms'], confidence: 0.86 } } };
  const ignored = { ...LEADS[1], id: 'llm000000000002', name: 'Model Ignored Ltd', segment: 'restaurant', segment_source: 'restaurant', segment_model: 'wholesale', extra: { ...LEADS[1].extra, llm: { segment: 'wholesale', size: 'unknown', buys: [], quantity: null, deadline: null, evidence: [], confidence: 0.4 } } };
  const { auth } = await withServer(t, { store: fixtureStore({ leads: [used, ignored] }) });
  const res = await auth('/leads');

  assert.equal(res.status, 200);
  assert.match(res.text, /the score uses the model/);
  assert.match(res.text, /below 0\.7 confidence, so the score ignores it/);
  assert.match(res.text, /reads as hotel - size large/);
  assert.match(res.text, /Saw you run two kitchens\./, 'the opener the model wrote is shown');
  assert.ok(!res.text.includes('<script>alert(1)</script>'), 'a quote from a page is escaped like any other page text');
  assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; we run 120 rooms/);
});

test('the runs page reports what the model stage cost, or why it did not run', async (t) => {
  const runs = [
    { id: 'run_a', city: 'bengaluru', sources: ['news'], startedAt: '2026-09-11T01:00:00.000Z', summary: { candidates: 10, leadsTotal: 8, llm: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', calls: 5, notNeeded: 4, cacheHits: 2, costInr: 0.1865, budgetSkipped: 1, invalid: 0, errors: 0, enriched: 3, openers: 2 } }, bundleHash: 'a'.repeat(64) },
    { id: 'run_b', city: 'bengaluru', sources: ['news'], startedAt: '2026-09-10T01:00:00.000Z', summary: { candidates: 10, leadsTotal: 8, llm: { enabled: false, reason: '--no-llm' } }, bundleHash: 'b'.repeat(64) },
  ];
  const { auth } = await withServer(t, { store: fixtureStore({ runs }) });
  const res = await auth('/runs');

  assert.equal(res.status, 200);
  assert.match(res.text, /5 calls/);
  assert.match(res.text, /4 not needed/);
  assert.match(res.text, /2 cache hits/);
  assert.match(res.text, /1 budget skips/);
  assert.match(res.text, /Rs 0\.1865/);
  assert.match(res.text, /3 enriched, 2 openers/);
  assert.match(res.text, /off - --no-llm/);
});
