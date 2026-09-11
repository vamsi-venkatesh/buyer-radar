import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

/**
 * A prompt is a markdown file with a small front matter block:
 *
 *   ---
 *   version: enrich/2026-09-11a
 *   purpose: enrich
 *   ---
 *
 * The version string is part of the cache key, so editing a prompt file without
 * bumping its version would silently serve answers written by the old wording.
 * That is the one mistake this loader is here to make visible: it refuses a
 * prompt with no version rather than inventing one.
 */
function parsePrompt(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error(`prompt ${file} has no front matter block`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.version) throw new Error(`prompt ${file} has no version in its front matter`);
  return { version: meta.version, purpose: meta.purpose || null, body: text.slice(m[0].length).trim() };
}

const loaded = new Map();

/** Load a prompt by name, e.g. loadPrompt('enrich'). Cached per process. */
export function loadPrompt(name, { dir = PROMPT_DIR } = {}) {
  const key = path.join(dir, `${name}.md`);
  if (!loaded.has(key)) loaded.set(key, parsePrompt(readFileSync(key, 'utf8'), `${name}.md`));
  return loaded.get(key);
}

export { parsePrompt, PROMPT_DIR };
