# 5. Two stores behind one interface: Postgres, and a JSON file

Status: accepted, 2026-09-11

## Context

This runs in two very different places. On a server it wants a real database:
concurrent readers, a unique index for webhook idempotency, and a register that
survives a container rebuild. On a laptop - and in CI, and in a reviewer's
terminal five minutes after cloning - it should need nothing at all.

Requiring Postgres to try the product costs more users than it saves bugs. So
does an ORM, for a schema of four tables.

## Decision

`src/lib/store.mjs` opens one of two implementations behind an identical
interface:

- **Postgres** (`store-pg.mjs`) when `DATABASE_URL` is set. Tables are created on
  first run. `pg` is the project's only runtime dependency and it is **loaded
  lazily**, so it is never even required without a `DATABASE_URL`.
- **JSON files** (`store-json.mjs`) otherwise: `data/leads.json`,
  `data/runs.json`, `data/events.json`, under `RADAR_DATA_DIR` when set.

Both must pass the same tests. Idempotency - `hasEvent(kind, key)` - is a method
on the interface, backed by a unique index on `(type, event_key)` in Postgres and
by a scan in JSON.

## Consequences

- `npm install` is optional. `git clone && npm test && npm run demo` works with
  Node alone.
- Two implementations of every query is real duplicated work, and a bug can hide
  in one of them. The mitigation is that the suite runs against both, and that
  the interface is deliberately small.
- Postgres-specific hazards have to be handled in the Postgres store and only
  there: it strips NUL bytes and lone surrogates out of scraped text before
  writing, because a real tender page will eventually contain one and Postgres
  rejects the whole transaction when it does.
- The JSON store is for one process. It is not a small database and it is not
  documented as one.
