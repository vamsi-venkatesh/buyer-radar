import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bundleHash, verifyBundle, ReceiptChain } from '../src/lib/receipts.mjs';
import { EVIDENCE_SCHEMA } from '../src/config.mjs';

const RECEIPTS = [
  { seq: 0, type: 'run.created', at: '2026-09-11T06:00:00.000Z', runId: 'run_x', city: 'bengaluru' },
  { seq: 1, type: 'source.fetched', at: '2026-09-11T06:00:10.000Z', source: 'overpass', count: 42, ms: 1234 },
  { seq: 2, type: 'source.blocked', at: '2026-09-11T06:00:13.000Z', source: 'cppp', reason: 'captcha' },
  { seq: 3, type: 'leads.upserted', at: '2026-09-11T06:00:14.000Z', new: 40, updated: 2 },
  { seq: 4, type: 'digest.rendered', at: '2026-09-11T06:00:15.000Z', chars: 900 },
  { seq: 5, type: 'evidence.sealed', at: '2026-09-11T06:00:15.500Z', runId: 'run_x', receiptCount: 5 },
];

test('the hash recipe is exactly schema, count, then each receipt line', () => {
  let payload = `${EVIDENCE_SCHEMA}\n${RECEIPTS.length}\n`;
  for (const r of RECEIPTS) payload += `${JSON.stringify(r)}\n`;
  const expected = createHash('sha256').update(payload, 'utf8').digest('hex');
  assert.equal(bundleHash(RECEIPTS), expected);
  assert.match(bundleHash(RECEIPTS), /^[0-9a-f]{64}$/);
});

test('the hash reproduces after a JSON round trip', () => {
  const bundle = {
    schema: EVIDENCE_SCHEMA,
    runId: 'run_x',
    receiptCount: RECEIPTS.length,
    hash: bundleHash(RECEIPTS),
    receipts: RECEIPTS,
  };
  const reloaded = JSON.parse(JSON.stringify(bundle));
  const result = verifyBundle(reloaded);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.recomputed, bundle.hash);
});

test('any change to any receipt breaks the hash', () => {
  const tampered = RECEIPTS.map((r, i) => (i === 1 ? { ...r, count: 43 } : r));
  assert.notEqual(bundleHash(tampered), bundleHash(RECEIPTS));
  const bundle = {
    schema: EVIDENCE_SCHEMA,
    runId: 'run_x',
    receiptCount: tampered.length,
    hash: bundleHash(RECEIPTS),
    receipts: tampered,
  };
  const result = verifyBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith('hash mismatch')));
});

test('receipt order is part of the hash', () => {
  const swapped = [...RECEIPTS];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.notEqual(bundleHash(swapped), bundleHash(RECEIPTS));
});

test('a sealed chain verifies and ends with evidence.sealed', () => {
  const chain = new ReceiptChain('run_test');
  chain.add('run.created', { city: 'bengaluru' });
  chain.add('source.fetched', { source: 'news', count: 7, ms: 10 });
  chain.add('source.blocked', { source: 'cppp', reason: 'captcha' });
  chain.add('leads.upserted', { new: 7, updated: 0 });
  chain.add('digest.rendered', { chars: 500 });
  const bundle = chain.seal();

  assert.equal(bundle.schema, EVIDENCE_SCHEMA);
  assert.equal(bundle.receipts.length, 6);
  assert.equal(bundle.receiptCount, 6);
  assert.equal(bundle.receipts.at(-1).type, 'evidence.sealed');
  assert.equal(bundle.receipts.at(-1).receiptCount, 5, 'sealed records the count before itself');
  bundle.receipts.forEach((r, i) => assert.equal(r.seq, i));
  assert.equal(verifyBundle(bundle).ok, true);
  assert.deepEqual(
    bundle.receipts.map((r) => r.type),
    ['run.created', 'source.fetched', 'source.blocked', 'leads.upserted', 'digest.rendered', 'evidence.sealed']
  );
});
