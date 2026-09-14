import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const DATA_DIR = path.join(ROOT, 'data');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * File-backed store. Used whenever DATABASE_URL is unset, so the whole pipeline
 * runs with no database and no install step.
 */
export function createJsonStore({ dataDir = DATA_DIR } = {}) {
  const leadsFile = path.join(dataDir, 'leads.json');
  const runsFile = path.join(dataDir, 'runs.json');
  const eventsFile = path.join(dataDir, 'events.json');
  const llmCacheFile = path.join(dataDir, 'llm-cache.json');
  const llmSpendFile = path.join(dataDir, 'llm-spend.json');
  const ordersFile = path.join(dataDir, 'orders.json');

  return {
    kind: 'json',
    describe: () => `json:${path.relative(ROOT, leadsFile)}`,

    async init() {
      await mkdir(dataDir, { recursive: true });
    },

    async allLeads() {
      return readJson(leadsFile, []);
    },

    async putLeads(leads) {
      await writeJson(leadsFile, leads);
    },

    async getLead(id) {
      const all = await readJson(leadsFile, []);
      return all.find((l) => l.id === id) || null;
    },

    async updateLead(id, patch) {
      const all = await readJson(leadsFile, []);
      const i = all.findIndex((l) => l.id === id);
      if (i === -1) return null;
      all[i] = { ...all[i], ...patch };
      await writeJson(leadsFile, all);
      return all[i];
    },

    async putRun(run) {
      const runs = await readJson(runsFile, []);
      const i = runs.findIndex((r) => r.id === run.id);
      if (i === -1) runs.push(run);
      else runs[i] = run;
      await writeJson(runsFile, runs);
    },

    async allRuns() {
      return readJson(runsFile, []);
    },

    async allEvents() {
      return readJson(eventsFile, []);
    },

    async appendEvents(events) {
      const all = await readJson(eventsFile, []);
      all.push(...events);
      await writeJson(eventsFile, all);
    },

    /**
     * Has an event of this type already been recorded under this key? The
     * webhook uses it for idempotency: a WhatsApp message id, or an
     * (id, status) pair, is acted on once however many times Meta delivers it.
     */
    async hasEvent(kind, key) {
      if (!kind || !key) return false;
      const all = await readJson(eventsFile, []);
      return all.some((e) => e.type === kind && e.key === key);
    },

    // ---------------------------------------------------------------- orders

    async allOrders() {
      const all = await readJson(ordersFile, []);
      return [...all].sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
    },

    async getOrder(id) {
      const all = await readJson(ordersFile, []);
      return all.find((o) => o.id === String(id)) || null;
    },

    /** The order reference is the key here too: a replay inserts nothing. */
    async putOrder(order) {
      const all = await readJson(ordersFile, []);
      if (all.some((o) => o.id === order.id)) return { inserted: false };
      all.push(order);
      await writeJson(ordersFile, all);
      return { inserted: true };
    },

    async updateOrder(id, patch) {
      const all = await readJson(ordersFile, []);
      const i = all.findIndex((o) => o.id === String(id));
      if (i === -1) return null;
      all[i] = { ...all[i], ...patch };
      await writeJson(ordersFile, all);
      return all[i];
    },

    // ---------------------------------------------------------- the LLM stage

    async getLlmCache(key) {
      const all = await readJson(llmCacheFile, {});
      return all[key] || null;
    },

    async putLlmCache(row) {
      const all = await readJson(llmCacheFile, {});
      all[row.key] = row;
      await writeJson(llmCacheFile, all);
    },

    /**
     * The day's model spend in INR. Kept on disk, not in memory, so a restart
     * resumes the same day's total instead of handing the cap back.
     */
    async llmSpend(day) {
      const all = await readJson(llmSpendFile, {});
      return Number(all[day] || 0);
    },

    async addLlmSpend(day, amountInr) {
      const all = await readJson(llmSpendFile, {});
      all[day] = Math.round((Number(all[day] || 0) + Number(amountInr || 0)) * 10000) / 10000;
      await writeJson(llmSpendFile, all);
      return all[day];
    },

    async close() {},
  };
}
