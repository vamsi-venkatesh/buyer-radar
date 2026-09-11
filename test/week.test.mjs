import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeek, weekRange, previousWeek, inWeek, shortDate, lastDays } from '../src/lib/week.mjs';

test('iso week numbers match the ISO-8601 rule at the year boundary', () => {
  assert.equal(isoWeek(new Date('2026-09-11T06:00:00Z')), '2026-W37');
  // 2026-01-01 is a Thursday, so it is in week 1 of 2026.
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  // 2027-01-01 is a Friday, so it belongs to the last week of 2026.
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  // 2024-12-30 is a Monday and belongs to week 1 of 2025.
  assert.equal(isoWeek(new Date('2024-12-30T00:00:00Z')), '2025-W01');
});

test('a week range runs Monday to Sunday', () => {
  assert.deepEqual(weekRange('2026-W37'), { start: '2026-09-07', end: '2026-09-13' });
  assert.deepEqual(weekRange('2026-W01'), { start: '2025-12-29', end: '2026-01-04' });
  assert.deepEqual(weekRange('2026-W53'), { start: '2026-12-28', end: '2027-01-03' });
});

test('a week that does not exist is rejected, not rounded', () => {
  assert.throws(() => weekRange('2025-W53'), /no such ISO week/);
  assert.throws(() => weekRange('2026-W54'), /out of range/);
  assert.throws(() => weekRange('week 37'), /must look like/);
});

test('previousWeek crosses the year boundary', () => {
  assert.equal(previousWeek('2026-W37'), '2026-W36');
  assert.equal(previousWeek('2026-W01'), '2025-W52');
});

test('inWeek is inclusive of both ends and ignores the time of day', () => {
  const r = weekRange('2026-W37');
  assert.equal(inWeek('2026-09-07T00:00:00Z', r), true);
  assert.equal(inWeek('2026-09-13T23:59:59Z', r), true);
  assert.equal(inWeek('2026-09-06T23:59:59Z', r), false);
  assert.equal(inWeek('2026-09-14', r), false);
  assert.equal(inWeek(null, r), false);
});

test('shortDate and lastDays', () => {
  assert.equal(shortDate('2026-09-07'), '07 Sep');
  assert.deepEqual(lastDays(3, '2026-09-11'), ['2026-09-09', '2026-09-10', '2026-09-11']);
  assert.equal(lastDays(14, '2026-09-11').length, 14);
});
