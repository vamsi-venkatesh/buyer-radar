import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSafe } from '../src/lib/store-pg.mjs';

test('pgSafe strips NUL and lone surrogates recursively and keeps Dates', () => {
  const out = pgSafe({ name: 'A\u0000B', extra: { notes: ['x\uD800y', 'oké'] }, when: new Date(0), n: 3 });
  assert.equal(out.name, 'AB');
  assert.equal(out.extra.notes[0], 'xy');
  assert.equal(out.extra.notes[1], 'oké');
  assert.ok(out.when instanceof Date);
  assert.equal(out.n, 3);
});
