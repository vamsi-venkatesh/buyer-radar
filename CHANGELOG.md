# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Two tiers on the openings lane, and only one of them costs money.** Every
  signal is tiered before anything is fetched: a `requirement_candidate` uses
  procurement wording next to a produce word and is read, an `awareness` item
  reports an opening or an expansion and is kept as a signal with its `why_now`
  for the price of one receipt (`openings.awareness_only`) and nothing else. The
  first real run of this lane on the reference deployment read 12 articles over
  34 model calls and found a posted requirement in none of them; all 12 were
  opening stories.
- **A procurement-wording pre-check on the model gate.** `needsModel('requirement',
  ...)` now refuses a call for a text that never uses procurement wording at all,
  above every other requirement rule including the article rule:
  `llm.not_needed { reason: 'no procurement wording' }`.
- **`OPENINGS_MAX_READS`, default 6.** A per-run ceiling on article reads, and
  therefore on requirement calls. When it is reached the remaining candidates are
  left unread with the reason on their own record and `openings.cap_reached` is
  written once.
- **`src/lib/profile.mjs`.** The word lists behind the two tiers in one place:
  the trade's half from the engine, the supplier's half from the client profile,
  and `signals` in `config/client.json` replaces either without a code change.
- **The run summary and the dashboard say what the lane read.** `openingsLine()`
  and a new **Openings** column: articles read, awareness-only, the cap, and
  whether it was reached.

- **The `publishers` source.** 37 direct RSS/Atom feeds published by Indian
  newspapers, trade titles and institutions, in `config/publisher-feeds.json`,
  each carrying the publisher's own article URL - so the openings lane has
  something it is allowed to read. All 67 candidates were probed once for real
  and `config/publisher-feeds.probe.json` records what each answered and why 30
  were dropped; `tools/probe-publisher-feeds.mjs` is the probe.
- **Atom support.** `parseAtomEntries()` and `parseFeedItems()` in
  `src/lib/xml.mjs`. About one publisher in five publishes Atom, and reading only
  `<item>` made those feeds look empty rather than unread.
- **A proximity rule on the keyword filter.** An item is kept only when its two
  matching words sit within 140 characters (a requirement) or 90 (an opening) of
  each other. Both words and the gap are written onto the candidate, so a receipt
  says why it was kept.
- **Publisher words come from the client profile.** The food-service half of the
  filter is the engine's; the commodity half is read from the catalogue, the
  headline commodity and the requirement keywords, so a non-produce supplier gets
  a lane that matches what he actually sells. Cities may now list `aliases`, so a
  paper writing "Bangalore" is still matched to Bengaluru.

### Changed

- **A publisher article always needs the model.** `needsModel('requirement', ...)`
  now takes `needsOrganisation`, and the openings lane sets it for every article
  it fetches. A notice is published by the buyer, so what is printed on it is the
  buyer's; an article is published by a newspaper about somebody else, and a
  phone number on it is the newsroom's. The contact is read off the
  organisation's own site or not at all.
- **A signal that can be read is spent on first.** `selectSignals()` sorts a
  signal whose link is already a publisher's article ahead of a Google News item
  whose opaque id is a known dead end, before score. The limit is a budget, and a
  run had been spending eleven of its twelve slots on links that resolve to
  nothing.
- **Sources receive `soFar`**, the candidates the earlier sources produced, so
  the publisher lane can drop a headline the news lane already holds.

### Fixed

- `eval/llm/results/` now carries the **real** DeepSeek run of 2026-09-11
  alongside the stub, so the numbers in the README and the case study can be read
  off the run rather than taken on trust.

## [0.1.0] - 2026-09-11

First public release. The engine had been running as a private deployment for a
Bengaluru fresh-produce supplier; this release generalises it so it runs for any
produce supplier from one configuration file.

### Added

- **The demand lane.** Buyers who have *posted a requirement*: institutional
  tender and notice pages (59 registered bodies), supplier-registration routes
  (22 buyers, Mondays only), the APEDA exporter directory, a flagged GeM client,
  and a stage that upgrades a news signal into a requirement with a contact.
- **The directory lane.** OpenStreetMap business listings via Overpass, Google
  News RSS signals, Agmarknet mandi prices, and a captcha-aware CPPP client that
  records a block rather than working around one.
- **Deterministic scoring** with published bands and worked examples
  (`docs/scoring.md`), dedup on normalised phone then name plus city, and a merge
  that never overwrites a status or a note.
- **A gated model stage.** `needsModel()` decides before every call; answers are
  cached on the prompt version, spend is capped per day in rupees and persisted,
  and every call, cache hit, refusal and skip is receipted.
- **Sealed evidence bundles** for runs, status changes, webhook batches and
  out-of-run tool calls, with the hash recipe published and `tools/verify.mjs` to
  check them.
- **A typed tool registry** with JSON Schema validation before the handler runs,
  owner-only gates on the two writing tools, and receipts for calls and refusals.
- **An MCP server** over stdio, JSON-RPC 2.0, no dependencies, defaulting to a
  read-only agent actor.
- **The owner's dashboard**: server-rendered HTML, no framework, no client-side
  JavaScript, mobile-first, one bearer token, and no unauthenticated mode.
- **A WhatsApp webhook** with constant-time HMAC verification over the exact
  bytes received, idempotency on message id, owner-only commands, and a privacy
  rule that records a non-owner message without its text.
- **Delivery to the owner only** - SMTP over implicit TLS with a dependency-free
  client, and the WhatsApp Cloud API. No channel can reach a buyer.
- **A weekly report**, a scheduler with no system cron in it, and a Docker image
  that runs both services.
- **An evaluation harness**: 30 labelled synthetic pages, a stub model for when
  there is no key, and a provider-agnostic scorer.
- **`npm run demo`** - the whole product in one command, with the network
  replaced by synthetic fixtures and nothing else changed.
- **`npm run validate`** - checks the client profile, the registries and the
  prompt versions, and fails on a committed key or token.
- Six architecture decision records in `docs/adr/`.

### Known limitations

These are in the roadmap and are stated here so nobody discovers them by
surprise.

- The openings lane resolves nothing today: every id in Google's current RSS feed
  is the opaque post-2024 form and carries no publisher URL. The resolver is
  correct; the supply is missing.
- 44 of the 59 registry entries did not answer when last probed, and 12 more
  published nothing matching the example catalogue. The probe records the cause
  for each.
- The GeM lane's parser is written against a response shape documented as assumed
  and never observed. It is off by default.
- The prices in `config/llm-prices.json` were written from prior knowledge, not
  fetched from a provider's pricing page. They are a cap, not an invoice.
- The evaluation is 30 synthetic cases. It is a smoke test, not a benchmark.
