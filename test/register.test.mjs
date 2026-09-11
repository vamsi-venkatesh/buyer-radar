import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toCsv, filterLeads, resolveLeadRef } from '../src/register.mjs';
import { createJsonStore } from '../src/lib/store-json.mjs';
import { toLead } from '../src/model.mjs';

const NOW = '2026-09-11T06:00:00.000Z';

function lead(over = {}) {
  return {
    ...toLead(
      {
        kind: 'buyer',
        segment: 'wholesale',
        name: 'Example Traders',
        city: 'Bengaluru',
        state: 'Karnataka',
        phone: '+919845012345',
        source: 'overpass',
        sourceUrl: 'https://www.openstreetmap.org/node/1',
        licence: 'ODbL',
        externalId: 'node/1',
      },
      { nowIso: NOW }
    ),
    ...over,
  };
}

test('csv export quotes commas, quotes and newlines', () => {
  const csv = toCsv([
    lead({ name: 'Sharma, Kumar & Co', notes: 'said "call back"\nnext week', score: 88 }),
  ]);
  const [header, row] = csv.trim().split('\n').slice(0, 1).concat(csv.trim().slice(csv.indexOf('\n') + 1));
  assert.ok(header.startsWith('id,kind,segment,name'));
  assert.ok(row.includes('"Sharma, Kumar & Co"'));
  assert.ok(row.includes('""call back""'));
});

test('csv export has one header line and one line per lead field set', () => {
  const csv = toCsv([lead(), lead({ id: 'other', name: 'Second' })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0].split(',').length, 22);
  assert.match(lines[0], /segment_source,segment_model,opener_model$/, 'the export carries what the model read');
  assert.ok(csv.endsWith('\n'));
});

test('filterLeads narrows by status, city and kind and sorts by score', () => {
  const leads = [
    lead({ id: 'a', score: 10 }),
    lead({ id: 'b', score: 90 }),
    lead({ id: 'c', score: 50, status: 'contacted' }),
    lead({ id: 'd', score: 70, city: 'Chennai' }),
    lead({ id: 'e', score: 60, kind: 'tender' }),
  ];
  assert.deepEqual(filterLeads(leads, { status: 'new' }).map((l) => l.id), ['b', 'd', 'e', 'a']);
  assert.deepEqual(filterLeads(leads, { city: 'bengaluru', status: 'new' }).map((l) => l.id), ['b', 'e', 'a']);
  assert.deepEqual(filterLeads(leads, { kind: 'tender' }).map((l) => l.id), ['e']);
  assert.deepEqual(filterLeads(leads, { minScore: 60 }).map((l) => l.id), ['b', 'd', 'e']);
});

test('L<n> resolves against the most recent digest index', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fqr-digests-'));
  await writeFile(path.join(dir, '2026-09-10.index.json'), JSON.stringify({ L1: 'old-lead' }));
  await writeFile(path.join(dir, '2026-09-11.index.json'), JSON.stringify({ L1: 'new-lead', L2: 'second' }));
  assert.deepEqual(await resolveLeadRef('L1', { digestsDir: dir }), { id: 'new-lead', via: '2026-09-11.index.json' });
  assert.deepEqual(await resolveLeadRef('L2', { digestsDir: dir }), { id: 'second', via: '2026-09-11.index.json' });
  await assert.rejects(() => resolveLeadRef('L9', { digestsDir: dir }), /not in the latest digest/);
});

test('a raw lead id passes through unresolved', async () => {
  assert.deepEqual(await resolveLeadRef('4f2a9c1b3d5e7081'), { id: '4f2a9c1b3d5e7081', via: 'id' });
});

test('json store round-trips leads and applies a status update', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fqr-data-'));
  const store = createJsonStore({ dataDir: dir });
  await store.init();
  const a = lead();
  await store.putLeads([a]);

  assert.deepEqual((await store.allLeads()).map((l) => l.id), [a.id]);
  const updated = await store.updateLead(a.id, { status: 'contacted', notes: '2026-09-11 contacted: rang' });
  assert.equal(updated.status, 'contacted');
  assert.equal((await store.getLead(a.id)).status, 'contacted');
  assert.equal(await store.getLead('missing'), null);

  await store.putRun({ id: 'run_1', city: 'bengaluru', summary: {} });
  assert.equal((await store.allRuns()).length, 1);
  await store.appendEvents([{ seq: 0, type: 'lead.status_changed', at: NOW }]);
  const events = JSON.parse(await readFile(path.join(dir, 'events.json'), 'utf8'));
  assert.equal(events.length, 1);
  await store.close();
});
