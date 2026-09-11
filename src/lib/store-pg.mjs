// Postgres store. The pg module is imported lazily so the project still runs
// with no dependencies installed when DATABASE_URL is unset.

const DDL = `
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  segment      TEXT NOT NULL,
  name         TEXT NOT NULL,
  city         TEXT,
  state        TEXT,
  address      TEXT,
  phone        TEXT,
  email        TEXT,
  website      TEXT,
  why_now      TEXT,
  source       TEXT NOT NULL,
  source_url   TEXT,
  licence      TEXT,
  first_seen   TIMESTAMPTZ NOT NULL,
  last_seen    TIMESTAMPTZ NOT NULL,
  score        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'new',
  notes        TEXT,
  extra        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
CREATE INDEX IF NOT EXISTS leads_city_idx   ON leads (city);
CREATE INDEX IF NOT EXISTS leads_score_idx  ON leads (score DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  city        TEXT,
  sources     TEXT[],
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  dry         BOOLEAN NOT NULL DEFAULT FALSE,
  summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  bundle_hash TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL PRIMARY KEY,
  run_id  TEXT,
  seq     INTEGER,
  type    TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- An event may carry an idempotency key (a WhatsApp message id, or an
-- "<id>:<status>" pair). The unique index is what makes a redelivered webhook
-- event a no-op in the database as well as in the code.
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_kind_key_idx
  ON events (type, event_key) WHERE event_key IS NOT NULL;

-- The LLM stage. segment_source is what the source said, segment_model is what
-- the model said; the score picks between them by confidence and neither
-- overwrites the other.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS segment_source TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS segment_model  TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS opener_model   TEXT;

-- Content-addressed answers. The key already carries the provider, the model,
-- the prompt version and the input, so the row is keyed on it alone.
CREATE TABLE IF NOT EXISTS llm_cache (
  key            TEXT PRIMARY KEY,
  provider       TEXT,
  model          TEXT,
  prompt_version TEXT,
  input_hash     TEXT,
  value          TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_inr       NUMERIC
);

-- One row per day. The cap is only a cap if it survives a restart.
CREATE TABLE IF NOT EXISTS llm_spend (
  day      DATE PRIMARY KEY,
  cost_inr NUMERIC NOT NULL DEFAULT 0
);
`;

const LEAD_COLUMNS = [
  'id', 'kind', 'segment', 'name', 'city', 'state', 'address', 'phone', 'email',
  'website', 'why_now', 'source', 'source_url', 'licence', 'first_seen',
  'last_seen', 'score', 'status', 'notes', 'extra', 'segment_source',
  'segment_model', 'opener_model',
];

function rowFromLead(lead) {
  return LEAD_COLUMNS.map((c) => (c === 'extra' ? JSON.stringify(lead.extra || {}) : lead[c] ?? null));
}

/** pg hands back Date objects for TIMESTAMPTZ; the rest of the app speaks ISO strings. */
function iso(v) { return v instanceof Date ? v.toISOString() : v; }
function leadFromRow(row) {
  row = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]));
  return { ...row, extra: row.extra || {} };
}

/**
 * Runs come back in the same shape the JSON store keeps them, so the report,
 * the dashboard and the CLI read one field set whichever store is in use.
 */
function runFromRow(row) {
  row = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]));
  return {
    id: row.id,
    city: row.city,
    sources: row.sources || [],
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at,
    dry: Boolean(row.dry),
    summary: row.summary || {},
    bundleHash: row.bundle_hash || null,
  };
}

function eventFromRow(row) {
  row = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]));
  const at = row.at instanceof Date ? row.at.toISOString() : row.at;
  return { seq: row.seq, type: row.type, at, runId: row.run_id, key: row.event_key ?? null, ...(row.payload || {}) };
}

/** Postgres text/jsonb cannot hold NUL (\\u0000) or lone surrogates; PDF text sometimes carries them. */
export function pgSafe(v) {
  if (typeof v === 'string') return v.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  if (Array.isArray(v)) return v.map(pgSafe);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pgSafe(x)]));
  return v;
}

export async function createPgStore(connectionString) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 4 });

  return {
    kind: 'postgres',
    describe: () => 'postgres',

    async init() {
      await pool.query(DDL);
    },

    async allLeads() {
      const { rows } = await pool.query('SELECT * FROM leads');
      return rows.map(leadFromRow);
    },

    async putLeads(leads) {
      leads = leads.map(pgSafe);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cols = LEAD_COLUMNS.join(', ');
        const params = LEAD_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
        const updates = LEAD_COLUMNS.filter((c) => c !== 'id')
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(', ');
        const sql = `INSERT INTO leads (${cols}) VALUES (${params})
                     ON CONFLICT (id) DO UPDATE SET ${updates}`;
        for (const lead of leads) await client.query(sql, rowFromLead(lead));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getLead(id) {
      const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
      return rows[0] ? leadFromRow(rows[0]) : null;
    },

    async updateLead(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.getLead(id);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const vals = keys.map((k) => (k === 'extra' ? JSON.stringify(patch[k]) : patch[k]));
      const { rows } = await pool.query(
        `UPDATE leads SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...vals]
      );
      return rows[0] ? leadFromRow(rows[0]) : null;
    },

    async putRun(run) {
      await pool.query(
        `INSERT INTO runs (id, city, sources, started_at, finished_at, dry, summary, bundle_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           city=EXCLUDED.city, sources=EXCLUDED.sources, started_at=EXCLUDED.started_at,
           finished_at=EXCLUDED.finished_at, dry=EXCLUDED.dry, summary=EXCLUDED.summary,
           bundle_hash=EXCLUDED.bundle_hash`,
        [
          run.id, run.city, run.sources, run.startedAt, run.finishedAt,
          Boolean(run.dry), JSON.stringify(run.summary || {}), run.bundleHash || null,
        ]
      );
    },

    async allRuns() {
      const { rows } = await pool.query('SELECT * FROM runs ORDER BY started_at DESC');
      return rows.map(runFromRow);
    },

    async allEvents() {
      const { rows } = await pool.query('SELECT * FROM events ORDER BY id ASC');
      return rows.map(eventFromRow);
    },

    async appendEvents(events) {
      events = events.map(pgSafe);
      for (const e of events) {
        const { seq, type, at, runId, key, ...payload } = e;
        await pool.query(
          `INSERT INTO events (run_id, seq, type, at, payload, event_key)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (type, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
          [runId ?? null, seq ?? null, type, at, JSON.stringify(payload), key ?? null]
        );
      }
    },

    /** Idempotency check for the webhook; see the unique index in the DDL. */
    async hasEvent(kind, key) {
      if (!kind || !key) return false;
      const { rows } = await pool.query(
        'SELECT 1 FROM events WHERE type = $1 AND event_key = $2 LIMIT 1',
        [kind, key]
      );
      return rows.length > 0;
    },

    // ---------------------------------------------------------- the LLM stage

    async getLlmCache(key) {
      const { rows } = await pool.query('SELECT * FROM llm_cache WHERE key = $1', [key]);
      if (!rows[0]) return null;
      const row = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, iso(v)]));
      return { ...row, cost_inr: row.cost_inr === null ? null : Number(row.cost_inr) };
    },

    async putLlmCache(row) {
      await pool.query(
        `INSERT INTO llm_cache (key, provider, model, prompt_version, input_hash, value, at, input_tokens, output_tokens, cost_inr)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (key) DO NOTHING`,
        [
          row.key, row.provider ?? null, row.model ?? null, row.prompt_version ?? null,
          row.input_hash ?? null, row.value, row.at, row.input_tokens ?? null,
          row.output_tokens ?? null, row.cost_inr ?? null,
        ]
      );
    },

    async llmSpend(day) {
      const { rows } = await pool.query('SELECT cost_inr FROM llm_spend WHERE day = $1', [day]);
      return rows[0] ? Number(rows[0].cost_inr) : 0;
    },

    async addLlmSpend(day, amountInr) {
      const { rows } = await pool.query(
        `INSERT INTO llm_spend (day, cost_inr) VALUES ($1, $2)
         ON CONFLICT (day) DO UPDATE SET cost_inr = llm_spend.cost_inr + EXCLUDED.cost_inr
         RETURNING cost_inr`,
        [day, Number(amountInr || 0)]
      );
      return Number(rows[0].cost_inr);
    },

    async close() {
      await pool.end();
    },
  };
}
