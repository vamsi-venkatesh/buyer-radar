# Client proof: the IndiaMART export lane, 12 September 2026

The first lead list the reference client received from a directory source, with
the counts as they were read back from the register and the one refusal kept as
it was reported. This is what the automation produced; how the pages were read
is the service's own tooling and is not described here.

## What ran

Thirty catalogue queries against IndiaMART's public export directory, one query
per commodity in the client's profile, then one read of every distinct
organisation's public profile page for its city, state and business facts.
Every host was read at a fixed gap between requests, and no page was retried.

| Stage | Pages | Outcome |
|---|---|---|
| Directory queries | 30 | 29 produced a full table, 1 was refused |
| Organisation profile pages | 139 | 139 read, 0 refused |

The refusal, verbatim as the pipeline reported it, for the query `french beans`:

> The capture returned 10 rows but these fields were mostly empty: Price
> (7/10 empty). Reporting this as a failure rather than handing back half a
> table.

A table with seven empty prices is not a lead list, so it was not kept.

## Counts, from the register

| | |
|---|---|
| Listing rows read | 297 |
| Distinct organisations | 139 |
| With city | 136 |
| With state | 139 |
| With an annual turnover band | 138 |
| With a stated business type | 53 |
| With a phone number on the public page | **0** |
| Written to the client's register as `exporter_trader` | 139 |

States, top eight: Gujarat 32, Maharashtra 29, Tamil Nadu 13, Delhi 13,
Uttar Pradesh 9, Rajasthan 6, Haryana 5, Madhya Pradesh 4. Karnataka 4.

## What these leads are, and are not

They are exporters, processors and traders who list garlic, onion, capsicum,
broccoli, okra and the rest of the catalogue on a public export directory.
A processor or exporter buys in from farms, which is why they are in the
register as buyers. They are **not** posted requirements: nobody in this list
asked for anything. The directory publishes no phone or email on these pages;
its contact button leads to a login, and the service does not log in. Each
register row therefore carries name, city, state, turnover band, products
listed, prices quoted and the profile URL, and its licence field says so.

## Five sample rows

| Organisation | City | State | Turnover | Lists |
|---|---|---|---|---|
| Good Greens India Private Limited | Dindigul | Tamil Nadu | 25 to 100 Cr | baby corn, export grade |
| Supervedic Venture LLP | Surat | Gujarat | 1.5 to 5 Cr | cut okra, broccoli flakes |
| Agrilane Private Limited | Thane | Maharashtra | 0 to 40 L | A-grade broccoli, cartons |
| Matrix Exports | Bengaluru | Karnataka | | fresh vegetables |
| Ariant Veg Private Limited | Bengaluru | Karnataka | | fresh vegetables |

The full 139-row file is a client deliverable and a republication of a third
party's directory, so it is not committed here.

## Limits found on the way

- The directory serves ten cards per query and ignores a page parameter.
  Breadth comes from more queries, not from pagination.
- The city on a profile page sits in a header beside the organisation's name;
  four names containing `&` or `/` broke the split and were corrected by hand.
  The parser now splits on the organisation's own name.
