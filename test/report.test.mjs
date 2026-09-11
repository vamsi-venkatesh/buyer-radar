import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectReport,
  renderReportText,
  renderReportHtml,
  buildReport,
  writeReport,
  parseArgs,
  REPORT,
} from '../src/report.mjs';
import { fixtureStore, LEADS, RUNS, EVENTS } from './fixtures/store.mjs';

const WEEK = '2026-W37';
const TODAY = '2026-09-11';

const data = () => collectReport({ leads: LEADS, runs: RUNS, events: EVENTS, week: WEEK, today: TODAY });

test('leads found this week exclude last week and exclude price rows', () => {
  const d = data();
  // 9 buyer leads in the fixture, one of which was first seen last week.
  assert.equal(d.found, 8);
  assert.equal(d.registerTotal, 9);
  assert.equal(d.withPhone, 7); // "Nameless Mess" has no phone
  assert.equal(d.noContact, 1);
});

test('cities and segments are counted from the store', () => {
  const d = data();
  assert.deepEqual(d.byCity, [['Bengaluru', 6], ['Chennai', 2]]);
  assert.deepEqual(
    Object.fromEntries(d.bySegment),
    { hotel: 4, restaurant: 2, caterer: 1, wholesale: 1 }
  );
});

test('city spellings are grouped but never rewritten into a spelling the store does not hold', () => {
  const leads = [
    { ...LEADS[0], id: 'x1', city: 'Bengaluru' },
    { ...LEADS[0], id: 'x2', city: 'Bengaluru' },
    { ...LEADS[0], id: 'x3', city: 'bengaluru' },
    { ...LEADS[0], id: 'x4', city: 'Bengaluru,' },
  ];
  const d = collectReport({ leads, runs: [], events: [], week: WEEK, today: TODAY });
  // One row, counting all four, labelled with the spelling that appears most.
  assert.deepEqual(d.byCity, [['Bengaluru', 4]]);
  // And the label is always a spelling the store actually holds.
  const held = new Set(leads.map((l) => l.city));
  assert.ok(held.has(d.byCity[0][0]));
});

test('status changes are counted only inside the week, and the won list names the leads', () => {
  const d = data();
  assert.deepEqual(d.statusCounts, { contacted: 1, quoted: 0, won: 1, lost: 0, ignored: 0 });
  assert.deepEqual(d.wonNames, ['Anand Caterers']);
});

test('sources and blocked sources come from this week\'s runs only', () => {
  const d = data();
  assert.equal(d.runs, 2);
  assert.deepEqual(d.sources, [['overpass', 220], ['news', 40], ['cppp', 0]]);
  assert.equal(d.blocked.length, 1);
  assert.equal(d.blocked[0].source, 'cppp');
});

test('days without a run never include days that have not happened yet', () => {
  const d = data();
  // The week starts Mon 07 Sep; today is Fri 11 Sep. Runs on 09 and 10.
  assert.deepEqual(d.runDays, ['2026-09-09', '2026-09-10']);
  assert.deepEqual(d.daysWithoutRun, ['2026-09-07', '2026-09-08', '2026-09-11']);
  assert.ok(!d.daysWithoutRun.includes('2026-09-12'), 'a future day is not a missed day');
});

test('price movement is a mean of the week and is absent, not zero, with no prior reading', () => {
  const d = data();
  const garlic = d.priceMoves.find((p) => p.commodity === 'Garlic');
  assert.equal(garlic.thisWeek, 14500); // (14000 + 15000) / 2
  assert.equal(garlic.lastWeek, 12000);
  assert.equal(garlic.deltaPct, 21);
  assert.equal(garlic.readings, 2);
  const tomato = d.priceMoves.find((p) => p.commodity === 'Tomato');
  assert.equal(tomato.thisWeek, 1700);
  assert.equal(tomato.lastWeek, null);
  assert.equal(tomato.deltaPct, null);
  // One row per commodity, not one per catalogue item that maps onto it.
  assert.equal(new Set(d.priceMoves.map((p) => p.commodity)).size, d.priceMoves.length);
});

test('next actions are statements the data supports, capped at three', () => {
  const d = data();
  assert.equal(d.nextActions.length, 3);
  assert.match(d.nextActions[0], /^2 hotels in (Bengaluru|Chennai) untouched, all with a phone\.$/);
  assert.ok(d.nextActions.some((a) => /contacted, none quoted yet/.test(a)));
  assert.ok(d.nextActions.some((a) => /cppp was blocked/.test(a)));
});

test('an empty store produces a report with zeros and no invented actions', () => {
  const d = collectReport({ leads: [], runs: [], events: [], week: WEEK, today: TODAY });
  assert.equal(d.found, 0);
  assert.equal(d.priceMoves.length, 0);
  assert.deepEqual(d.wonNames, []);
  const text = renderReportText(d);
  assert.match(text, /Leads found this week: 0 \(0 with a phone\)/);
  assert.match(text, /no mandi readings stored this week/);
  assert.ok(!/undefined|NaN|null/.test(text), text);
});

test('the text report stays under the character cap with a large week', () => {
  const many = [];
  for (let i = 0; i < 400; i += 1) {
    many.push({
      ...LEADS[0],
      id: `big${i}`,
      name: `A Very Long Trading Name For Lead Number ${i} Private Limited`,
      city: `City With A Long Name ${i % 25}`,
      segment: ['hotel', 'restaurant', 'wholesale', 'caterer', 'retailer', 'institution', 'distributor'][i % 7],
    });
  }
  const d = collectReport({ leads: [...many, ...LEADS], runs: RUNS, events: EVENTS, week: WEEK, today: TODAY });
  const text = renderReportText(d);
  assert.ok(text.length <= REPORT.maxChars, `${text.length} <= ${REPORT.maxChars}`);
  assert.match(text, /more/, 'a trimmed list says that it trimmed');
});

test('the html report escapes a hostile trading name and city', () => {
  const evil = { ...LEADS[0], id: 'evil', name: '<script>alert(1)</script>', city: '"><b>x' };
  const events = [
    { seq: 0, type: 'lead.status_changed', at: '2026-09-09T09:00:00.000Z', leadId: 'evil', from: 'new', to: 'won' },
  ];
  const d = collectReport({ leads: [evil], runs: [], events, week: WEEK, today: TODAY });
  // The name only reaches the page through the won list, so this proves the
  // path a hostile listing name would actually travel.
  assert.deepEqual(d.wonNames, ['<script>alert(1)</script>']);
  const html = renderReportHtml(d);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw script tag is not in the page');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('"><b>x'));
});

test('buildReport reads a store and writeReport writes both files', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'radar-report-'));
  const built = await buildReport({ week: WEEK, today: TODAY, store: fixtureStore() });
  assert.equal(built.data.found, 8);
  const files = await writeReport(WEEK, built, { dir });
  assert.equal(path.basename(files.txt), '2026-W37.txt');
  assert.equal(path.basename(files.html), '2026-W37.html');
  const txt = await readFile(files.txt, 'utf8');
  assert.match(txt, new RegExp(`${CLIENT.digest.title} - week 2026-W37 \\(07 Sep - 13 Sep\\)`));
  assert.match(txt, /Won: Anand Caterers/);
  const html = await readFile(files.html, 'utf8');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Anand Caterers/);
});

test('parseArgs defaults to the current week and rejects a week that does not exist', () => {
  assert.match(parseArgs([]).week, /^\d{4}-W\d{2}$/);
  assert.equal(parseArgs(['--week', '2026-W37']).week, '2026-W37');
  assert.throws(() => parseArgs(['--week', '2025-W53']), /no such ISO week/);
  assert.throws(() => parseArgs(['--month', '9']), /unknown argument/);
});
