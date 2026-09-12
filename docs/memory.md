# Memory

What this service keeps between runs, what it refuses to keep, and for how
long. Every row below was read off the code that writes it; where nothing in the
code deletes a class of data, this page says **not enforced yet** rather than
quoting a policy that does not exist.

There are two stores and they hold the same things. Postgres is used when
`DATABASE_URL` is set (`src/lib/store-pg.mjs`); otherwise everything goes to
JSON files under `data/` (`src/lib/store-json.mjs`). The table names below are
the Postgres ones, with the file that stands in for each in the JSON store.

## What it remembers

### Lead identity and status

A lead's id is `sha256(source + " " + externalId)`, first 16 hex characters
(`leadId()` in `src/lib/hash.mjs`). It is deterministic across runs and across
machines, so the same listing is the same row tomorrow.

What is kept on the row: kind, segment (the source's answer and the model's,
side by side, never overwriting each other), trading name, city, state, address,
phone, email, website, the why-now line and its date, the source and its URL,
the licence the source publishes under, first seen, last seen, score, status,
free-text notes, and an `extra` object carrying the requirement fields, the
score parts and anything the model read.

Status and notes are the part that belongs to the owner rather than to a fetch.
A second sighting merges into the existing row and `mergeLeads()` in
`src/model.mjs` explicitly re-copies the existing status and notes over the
merge, so no fetch can ever reset a lead the owner has already worked. Every
status change also writes a dated line to `notes` and a sealed receipt to
`runs/status_<id>.evidence.json` (`setLeadStatus()` in `src/register.mjs`).

- **Where:** table `leads` — JSON store `data/leads.json`.
- **Status changes also land in:** table `events`, type `lead.status_changed` —
  JSON store `data/events.json`; and a receipt file under `runs/`.
- **Retention:** **not enforced yet.** Nothing in the code deletes or ages out a
  lead, and there is no expiry column. A lead stays until somebody removes it by
  hand.

### Per-source daily yield

Each run writes one row: the run id, the city, the sources asked for, when it
started and finished, whether it was a dry run, the bundle hash, and a summary
object. Inside the summary, `perSource` carries the count, the elapsed
milliseconds and the blocked reason for every source the run touched — that is
the daily yield, and the weekly report and the dashboard read it from there.

- **Where:** table `runs`, column `summary` — JSON store `data/runs.json`.
- **Retention:** **not enforced yet.** Runs are inserted and updated, never
  deleted.

### Price history

Mandi prices are stored as leads of kind `price`, one per state, district,
market, commodity, variety and arrival date (`src/sources/agmarknet.mjs`
composes that as the external id). Because the id is deterministic and carries
the arrival date, yesterday's quote and today's are two rows, and the history
accumulates on its own. The API key is stripped out of the stored source URL
before anything is written (`redact()` in the same file).

- **Where:** table `leads`, rows where `kind = 'price'` — JSON store
  `data/leads.json`.
- **Retention:** **not enforced yet.** No price row is ever aged out.

### Model cache

One row per distinct question. The key is a hash of the provider, the model, the
prompt version and the exact input text, so a cached answer can never be served
for a question that was not asked. The row carries the provider, the model, the
prompt version, the hash of the input, the answer text, the timestamp, the token
counts and the cost.

The input text itself is **not** stored — only its hash — so the cache does not
become a second copy of every page the service has read.

- **Where:** table `llm_cache` — JSON store `data/llm-cache.json`.
- **Retention:** **no expiry, by design.** `src/llm/cache.mjs` says so in as
  many words: the four key parts describe the same question forever, so a stale
  answer is impossible by construction and there is nothing for an expiry to
  fix. Nothing deletes these rows.

### The day's model spend

One row per day holding the rupees spent. It is in the store rather than in
memory so that restarting the process, or running the pipeline twice in one
morning, resumes the same day's total instead of handing the cap back.

- **Where:** table `llm_spend`, keyed on `day` — JSON store
  `data/llm-spend.json`.
- **Retention:** **not enforced yet.** Old days are kept.

### Evidence

Every run seals a bundle of receipts and writes it to
`runs/<runId>.evidence.json`; the same receipts are also appended to `events`.
Work outside a run appends to a per-day bundle instead —
`runs/webhook_<date>.evidence.json` for the WhatsApp webhook and
`runs/tools_<date>.evidence.json` for the tool layer. Each receipt carries a
`role` (`scout`, `reader`, `verifier`, `desk`, `owner`, `auditor`), so a bundle
reads as who did what and not only as what happened.

- **Where:** files under `runs/`, plus table `events` — JSON store
  `data/events.json`.
- **Retention:** **not enforced yet.** Bundles are written and never pruned.

### Files the run leaves behind

`digests/<date>.txt`, `.full.txt`, `.prices.txt` and `.index.json`;
`exports/leads-<date>.csv` and `.json`; `outbox/<date>.eml` and
`<date>.whatsapp.json` when a channel was not configured. The outbox files carry
the exact request that would have been made, and never the API token.

- **Retention:** **not enforced yet.** Nothing rotates or deletes these.

## What it never remembers

### A buyer's conversation

There is none to remember. The service starts no conversation with a buyer and
therefore finishes none: the only outbound text path is `sendWhatsAppText()` in
`src/deliver.mjs`, and the only recipient the tool layer can reach is
`RADAR_TO_WA`, the owner's own number. `owner.message` has no recipient field at
all — reaching anybody else would mean rewriting that file, not configuring it.

### A non-owner's inbound message, beyond one line

An inbound WhatsApp message from any number that is not the owner's is recorded
and never answered. What is recorded is deliberately one line and no more
(`processWebhookBatch()` in `src/webhook.mjs`):

| Field | Stored? |
| --- | --- |
| `messageId` | yes |
| `from` | yes — the sender's number |
| `owner` | yes — `false` |
| `messageType` | yes |
| `textChars` | yes — the length only |
| `text` | **null** — the words are not stored |

The reply receipt for that message records `sent: false` with the reason. So the
service can prove what arrived and prove it did not answer, without keeping what
was said.

- **Where:** table `events`, type `whatsapp.inbound`, plus the matching receipt
  in `runs/webhook_<date>.evidence.json`.
- **Retention:** **not enforced yet.**

### Page text

The model stage hashes the input and stores the hash, never the page
(`inputHash()` in `src/llm/cache.mjs`, used in every `llm.call` and
`llm.cache_hit` receipt). Article and notice text is read, used and dropped.

### Keys and tokens

The Agmarknet API key is redacted out of the stored URL before the row is
written. The WhatsApp token only ever appears in a request header: it is not
written to the outbox file, not logged, and not put in a receipt.

## Summary

| Class | Table | JSON file | Retention |
| --- | --- | --- | --- |
| Lead identity and status | `leads` | `data/leads.json` | not enforced yet |
| Status changes | `events` + `runs/status_*.evidence.json` | `data/events.json` | not enforced yet |
| Per-source daily yield | `runs` (`summary.perSource`) | `data/runs.json` | not enforced yet |
| Price history | `leads` where `kind = 'price'` | `data/leads.json` | not enforced yet |
| Model cache | `llm_cache` | `data/llm-cache.json` | no expiry, by design |
| Daily model spend | `llm_spend` | `data/llm-spend.json` | not enforced yet |
| Evidence receipts | `events` + files under `runs/` | `data/events.json` | not enforced yet |
| Buyer conversations | — | — | never stored |
| Non-owner message text | — | — | never stored; one metadata line only |
| Page text read by the model | — | — | never stored; the hash only |
