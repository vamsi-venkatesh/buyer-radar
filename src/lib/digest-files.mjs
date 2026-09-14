import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DIGESTS_DIR } from './paths.mjs';

/**
 * Newest digests/<date>.txt and its price sheet, or nulls when none exists.
 * Read from disk only - this never invents a digest.
 */
export async function latestDigest(digestsDir = DIGESTS_DIR) {
  let files = [];
  try {
    files = (await readdir(digestsDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
  } catch {
    return { date: null, text: null, priceSheet: null };
  }
  if (!files.length) return { date: null, text: null, priceSheet: null };
  const date = files[files.length - 1].replace(/\.txt$/, '');
  const read = async (name) => {
    try {
      return await readFile(path.join(digestsDir, name), 'utf8');
    } catch {
      return null;
    }
  };
  return { date, text: await read(`${date}.txt`), priceSheet: await read(`${date}.prices.txt`) };
}

/**
 * One named day's digest and price sheet, or nulls when that day wrote none.
 *
 * The late-failure path needs the message of a particular morning, not the
 * newest one: a status callback can arrive after the next day's run has already
 * written a fresher digest, and resending that one would send the owner the
 * wrong day's leads.
 */
export async function digestForDate(date, digestsDir = DIGESTS_DIR) {
  const day = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { date: null, text: null, priceSheet: null };
  const read = async (name) => {
    try {
      return await readFile(path.join(digestsDir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const text = await read(`${day}.txt`);
  return { date: text === null ? null : day, text, priceSheet: await read(`${day}.prices.txt`) };
}
