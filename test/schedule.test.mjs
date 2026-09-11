import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeOfDay,
  zonedParts,
  instantForWallClock,
  nextRunAt,
  msUntil,
  waitUntil,
  MAX_TIMEOUT_MS,
} from '../src/lib/schedule.mjs';
import { cronConfig, upcoming, CRON_DEFAULTS } from '../src/cron.mjs';

test('parseTimeOfDay accepts HH:MM and rejects everything else', () => {
  assert.deepEqual(parseTimeOfDay('07:00'), { hour: 7, minute: 0 });
  assert.deepEqual(parseTimeOfDay('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseTimeOfDay('23:59'), { hour: 23, minute: 59 });
  assert.throws(() => parseTimeOfDay('24:00'), /out of range/);
  assert.throws(() => parseTimeOfDay('07:60'), /out of range/);
  assert.throws(() => parseTimeOfDay('7am'), /must look like 07:00/);
  assert.throws(() => parseTimeOfDay(''), /must look like 07:00/);
});

test('zonedParts reads the wall clock in the named zone, not the host zone', () => {
  // 2026-09-11T01:30Z is 07:00 in Asia/Kolkata (UTC+5:30).
  assert.deepEqual(zonedParts(new Date('2026-09-11T01:30:00Z'), 'Asia/Kolkata'), {
    year: 2026,
    month: 9,
    day: 11,
    hour: 7,
    minute: 0,
    second: 0,
  });
  // Midnight in Kolkata is the previous day 18:30 UTC.
  assert.equal(zonedParts(new Date('2026-09-10T18:30:00Z'), 'Asia/Kolkata').day, 11);
});

test('07:00 Asia/Kolkata is 01:30 UTC', () => {
  const at = instantForWallClock({ year: 2026, month: 9, day: 11, hour: 7, minute: 0 }, 'Asia/Kolkata');
  assert.equal(at.toISOString(), '2026-09-11T01:30:00.000Z');
});

test('nextRunAt is the next occurrence, strictly after now', () => {
  const opts = { at: '07:00', timeZone: 'Asia/Kolkata' };
  // Before today's run time.
  assert.equal(nextRunAt(new Date('2026-09-11T00:00:00Z'), opts).toISOString(), '2026-09-11T01:30:00.000Z');
  // Exactly at it - the next one is tomorrow, so a run cannot re-trigger itself.
  assert.equal(nextRunAt(new Date('2026-09-11T01:30:00Z'), opts).toISOString(), '2026-09-12T01:30:00.000Z');
  // After it.
  assert.equal(nextRunAt(new Date('2026-09-11T02:00:00Z'), opts).toISOString(), '2026-09-12T01:30:00.000Z');
  // Across a month end.
  assert.equal(nextRunAt(new Date('2026-09-30T12:00:00Z'), opts).toISOString(), '2026-10-01T01:30:00.000Z');
});

test('the scheduler follows a DST change rather than drifting by an hour', () => {
  const opts = { at: '07:00', timeZone: 'America/New_York' };
  // 08 Mar 2026 is the spring-forward day: 07:00 local is 12:00Z before and 11:00Z after.
  assert.equal(nextRunAt(new Date('2026-03-07T13:00:00Z'), opts).toISOString(), '2026-03-08T11:00:00.000Z');
  assert.equal(nextRunAt(new Date('2026-03-06T13:00:00Z'), opts).toISOString(), '2026-03-07T12:00:00.000Z');
});

test('msUntil never goes negative', () => {
  assert.equal(msUntil(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z')), 0);
  assert.equal(msUntil(new Date('2026-01-01T00:00:10Z'), new Date('2026-01-01T00:00:00Z')), 10000);
});

test('waitUntil chains timers instead of overflowing setTimeout on a long wait', () => {
  const waits = [];
  let fired = false;
  let now = new Date('2026-01-01T00:00:00Z');
  const far = new Date(now.getTime() + MAX_TIMEOUT_MS * 2 + 5000);
  const pending = [];
  const setTimer = (fn, ms) => {
    waits.push(ms);
    pending.push(fn);
    return { unref() {} };
  };
  waitUntil(far, () => {
    fired = true;
  }, { now: () => now, setTimer, clearTimer: () => {} });

  assert.equal(waits[0], MAX_TIMEOUT_MS, 'the first wait is capped, never the raw difference');
  assert.equal(fired, false);
  now = new Date(now.getTime() + MAX_TIMEOUT_MS);
  pending.shift()();
  assert.equal(waits[1], MAX_TIMEOUT_MS);
  now = new Date(now.getTime() + MAX_TIMEOUT_MS);
  pending.shift()();
  assert.equal(waits[2], 5000, 'the final wait is the exact remainder');
  now = far;
  pending.shift()();
  assert.equal(fired, true);
});

test('waitUntil can be cancelled', () => {
  let fired = false;
  const cancel = waitUntil(new Date(Date.now() + 60000), () => {
    fired = true;
  }, { setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  cancel();
  assert.equal(fired, false);
});

test('cronConfig defaults to 07:00 Asia/Kolkata for Bengaluru', () => {
  const c = cronConfig({});
  assert.equal(c.at, CRON_DEFAULTS.at);
  assert.equal(c.timeZone, 'Asia/Kolkata');
  assert.deepEqual(c.cities, ['bengaluru']);
  assert.deepEqual(c.sources, ['overpass', 'news', 'agmarknet']);
  assert.equal(c.limit, 200);
  assert.deepEqual(c.deliver, []);
});

test('cronConfig reads and validates the environment', () => {
  const c = cronConfig({
    RADAR_RUN_AT: '06:30',
    RADAR_TZ: 'Asia/Kolkata',
    RADAR_CITIES: 'bengaluru, chennai',
    RADAR_SOURCES: 'overpass,news',
    RADAR_LIMIT: '150',
    RADAR_DELIVER: 'email,whatsapp',
  });
  assert.deepEqual(c.cities, ['bengaluru', 'chennai']);
  assert.deepEqual(c.deliver, ['email', 'whatsapp']);
  assert.equal(c.limit, 150);
  assert.throws(() => cronConfig({ RADAR_CITIES: 'atlantis' }), /unknown city: atlantis/);
  assert.throws(() => cronConfig({ RADAR_RUN_AT: 'dawn' }), /must look like 07:00/);
  assert.throws(() => cronConfig({ RADAR_TZ: 'Middle/Earth' }), /not a time zone/);
  assert.throws(() => cronConfig({ RADAR_LIMIT: '0' }), /positive number/);
  assert.throws(() => cronConfig({ RADAR_DELIVER: 'pigeon' }), /unknown delivery channel/);
});

test('upcoming lists consecutive days at the configured time', () => {
  const c = cronConfig({ RADAR_RUN_AT: '07:00', RADAR_TZ: 'Asia/Kolkata' });
  const next = upcoming(c, new Date('2026-09-11T02:00:00Z'), 3).map((d) => d.toISOString());
  assert.deepEqual(next, [
    '2026-09-12T01:30:00.000Z',
    '2026-09-13T01:30:00.000Z',
    '2026-09-14T01:30:00.000Z',
  ]);
});
