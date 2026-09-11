// Wall-clock scheduling in a named time zone, using only Intl. No cron, no
// dependency, no assumption that the container's clock is set to Asia/Kolkata.

export const MAX_TIMEOUT_MS = 2147483647; // setTimeout silently fires at once above this

/** "07:00" -> { hour: 7, minute: 0 } */
export function parseTimeOfDay(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`RADAR_RUN_AT must look like 07:00, got: ${raw}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`RADAR_RUN_AT out of range: ${raw}`);
  return { hour, minute };
}

/** The wall-clock parts an instant shows in a given time zone. */
export function zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
  );
  return { ...parts, hour: parts.hour % 24 };
}

function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * The instant at which the given wall-clock time occurs in that zone. Two
 * passes settle the offset, which is what makes this correct across a DST
 * change - Asia/Kolkata has none, but the code must not depend on that.
 */
export function instantForWallClock({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const next = target - zoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/**
 * The next instant at which it is `at` in `timeZone`, strictly after `now`.
 * Deterministic: given the same now it always returns the same answer.
 */
export function nextRunAt(now, { at = '07:00', timeZone = 'Asia/Kolkata' } = {}) {
  const { hour, minute } = parseTimeOfDay(at);
  const here = zonedParts(now, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const base = new Date(Date.UTC(here.year, here.month - 1, here.day) + dayOffset * 86400000);
    const candidate = instantForWallClock(
      {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
        hour,
        minute,
      },
      timeZone
    );
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error(`could not find a next run time for ${at} in ${timeZone}`);
}

export function msUntil(target, now = new Date()) {
  return Math.max(0, target.getTime() - now.getTime());
}

/**
 * setTimeout truncates above 2^31-1 ms and fires immediately, which would turn
 * a long wait into a busy loop. This chains shorter waits instead. Returns a
 * cancel function.
 */
export function waitUntil(target, fn, { now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let handle = null;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const remaining = msUntil(target, now());
    if (remaining <= 0) {
      fn();
      return;
    }
    handle = setTimer(tick, Math.min(remaining, MAX_TIMEOUT_MS));
    if (handle && typeof handle.unref === 'function') handle.unref();
  };
  tick();
  return () => {
    cancelled = true;
    if (handle) clearTimer(handle);
  };
}
