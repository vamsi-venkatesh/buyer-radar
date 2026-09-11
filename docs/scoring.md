# Scoring

There are **two scales**, both 0-100, and which one a lead is scored on is
decided by its `kind` and nothing else.

| Kind | Scale | Why |
| --- | --- | --- |
| `requirement` | [The requirement scale](#the-requirement-scale) | The buyer has already said in public that he needs produce. What is left to judge is *when it shuts, whether we can fill it, whether there is a person to ring, and whether it is near enough to serve*. |
| `buyer`, `tender`, `signal`, `registration` | The buyer scale, below | Nobody has said they need anything. What is being judged is *whether this is the kind of business that buys what we sell, and whether we can reach it*. |

`scoreLead()` routes on kind. The two numbers are **not comparable** and are
never compared: the digest prints requirements and buyers in separate sections,
each ranked within itself, so a requirement scoring 52 is never shown as
"worse" than a map listing scoring 84.

The rest of this section describes the buyer scale, which is unchanged. The
requirement scale is documented after it.

Every buyer lead carries a score from 0 to 100. The score is **deterministic**: the same
lead, the same city and the same date always produce the same number. `scoreLead()`
makes no model call - it reads what is already on the record, including whatever
the LLM stage wrote there earlier in the run. The implementation is in
`src/model.mjs`; the constants below are exported from that file so the tests read
the same values the runner uses.

The score is a sum of five components plus one penalty, then clamped to 0-100.

## What the model may and may not move

The LLM stage (see the README) reads a lead's own web page or source article and
records what it made of it in `extra.llm`. Three of those fields are scoring
inputs: `segment`, `size` and `deadline`. Nothing else it returns - `buys`,
`quantity`, `evidence` - touches the score at all; those are there for the owner
to read.

The gate is `extra.llm.confidence >= 0.7` (`MODEL_MIN_CONFIDENCE`). Below it the
answer is still stored and still shown on the register, and it moves nothing. One
gate, read by `modelInputs()`, used by every consumer, so "did the model decide
this?" is never a question of which caller remembered to check.

| Model field | What it can do | What it can never do |
| --- | --- | --- |
| `segment` | Replace the source-derived segment in the segment component, at confidence >= 0.7. | Overwrite `lead.segment`. The source's answer stays in `segment_source`, the model's in `segment_model`, and both are kept. |
| `size` | Adjust the segment component by `large +6`, `medium +2`, `small -4`, `unknown 0`, within the band. | Lift the band past 30 or push it below 0, so the 0-100 total is unchanged. |
| `deadline` | Supply a date for the recency band when the record has none. | Replace a date the source already gave. The source's `whyNowDate` always wins. |

Because size adjusts the existing band rather than adding a component, a lead that
scored 84 before the stage existed cannot score higher than 84 now for any reason
other than the score reading a better segment or a real date - and a big
institution can climb toward the top of the band while a big wholesaler, already
at 30, gains nothing from being big.

## 1. Segment fit (0-30)

How well the buyer type matches what the supplier actually supplies. In the
worked example that is peeled garlic up to 1,000 kg/day, broccoli, capsicum, and
exotic and regular vegetables, sold B2B.

| Segment | Points | Why |
| --- | --- | --- |
| `wholesale` | 30 | Buys by the sack; the peeled-garlic volume lands here first. |
| `food_manufacturer` | 30 | Repeatable, planned volume; the best fit for daily capacity. |
| `hotel` | 30 | Daily standing requirement across several vegetables. |
| `restaurant` | 30 | Daily requirement, smaller per-site volume but far more sites. |
| `distributor` | 26 | Buys to resell; volume without end-customer service load. |
| `caterer` | 22 | Large but event-shaped, so less predictable week to week. |
| `retailer` | 18 | Greengrocers and supermarkets; smaller lots, price-led. |
| `institution` | 16 | Canteens, hostels, hospitals; usually reached through a tender. |
| `other` | 8 | Unclassified. |

The segment used here is the model's when it cleared the confidence gate,
otherwise the source's. `size` is then added to this component and the result is
clamped to 0-30, so this band is the only place a model answer can change a
number.

The example profile does not target cloud-kitchen operations. Listings that identify
themselves as one are dropped before scoring (`isExcluded()` in
`src/lib/normalise.mjs`), not scored down.

## 2. Contactability (0-30)

The single best contact route on the record. Only one band applies.

| Best contact | Points |
| --- | --- |
| Phone (parsed to E.164) | 30 |
| Email | 20 |
| Website only | 10 |
| None | 0 |

A phone number that cannot be parsed with confidence is stored as `null`, so the
lead scores as if it had no phone. A wrong number is worse than no number.

## 3. Recency of `why_now` (0-20)

Measured from `extra.whyNowDate` to the run date, or - only when the record has no
`whyNowDate` at all - from a `deadline` the model read off the page at confidence
>= 0.7.

| Band | Points |
| --- | --- |
| Within 14 days, or a future date such as a tender closing date | 20 |
| 15 to 30 days | 10 |
| Older than 30 days | 0 |
| No date on the record (for example a standing map listing) | 4 |

A map listing has no event date, so it gets the small `unknown` allowance rather
than a recency claim the data does not support.

## 4. City match (0 or 10)

10 points when the lead's city normalises to the city the run was asked for,
otherwise 0. Normalisation is lowercase, letters only.

## 5. Detail (0-10)

5 points for a usable address, 5 points for either coordinates or a website. This
separates a record the owner can act on from a bare name.

## Penalty: already worked (-25)

A lead whose status is anything other than `new` loses 25 points, so a buyer who
has already been contacted, quoted, won, lost or ignored stops competing for the
top of tomorrow's digest with genuinely new leads. Duplicates are merged into the
existing record (see below), so a second sighting of an already-contacted buyer
inherits that status and therefore that penalty.

## Worked example

A Bengaluru wholesale vegetable trader found on OpenStreetMap with a phone number
and a street address, on a run for Bengaluru:

```
segment        wholesale          30
contactability phone              30
recency        no date             4
cityMatch      Bengaluru          10
detail         address + coords   10
penalty        status = new        0
                                 ---
score                              84
```

A restaurant mentioned in a news item from three weeks ago, with no phone and no
address, in the same run:

```
segment        restaurant         24
contactability none                0
recency        15-30 days         10
cityMatch      Bengaluru          10
detail         none                0
penalty        status = new        0
                                 ---
score                              44
```

## Dedup

Deduplication runs before the final scoring pass, so a merged lead is scored once
on its merged facts.

1. **Normalised phone.** Two records whose phones normalise to the same E.164
   value are the same buyer. This catches `080-41123456` and `+91 80 4112 3456`.
2. **Normalised name + city.** Used only when there is no phone to match on. The
   name is lowercased, accent-stripped, punctuation-stripped, and common business
   words (`pvt`, `ltd`, `the`, `restaurant`, `hotel`, `stores`, ...) are removed.
   The city must match too, so two branches of the same chain in different cities
   stay separate leads.

When two records merge, the existing lead keeps its id, its `first_seen` and,
critically, its `status` and `notes` - those belong to the register, never to a
fetch. The merged record takes the later `last_seen`, the higher-fit segment, the
fresher `why_now`, and the union of known contact details. Every source that
contributed is listed in `extra.sources`.

## Digest ordering and ties

The register is ordered by score alone. The **digest** orders by score too, but
many leads tie exactly - a phone-bearing hotel with an address and coordinates
always scores 80, and Bengaluru has hundreds of them. Broken by lead id, a tie
hands all ten digest slots to whichever segment happens to have the most
phone-bearing map listings, which is not a useful morning list.

`diversifyTies()` in `src/digest.mjs` therefore reorders **within an equal-score
group only**: the next lead is the tied one whose segment has appeared least
often so far in the digest. Scores are not touched and score order is never
broken, so a higher-scoring lead can never be pushed below a lower-scoring one.
The rule is deterministic - equal score and equal segment count falls back to the
original id order.

## The `--limit` cap

`--limit` caps how many candidates a single run carries into the register. Map
listings almost always carry a phone number and therefore outscore every news
signal and tender, so a plain top-N cut sends every slot to `overpass` and the
other lanes never reach the register at all - that is exactly what the first
real run did.

`capCandidates()` in `src/run.mjs` therefore guarantees each contributing source
a share of the limit (`RUN.reservePerSource`, currently 20%) taken from that
source's own best-scoring candidates, then fills the remaining slots in global
score order with ties spread across segments. It is deterministic and it never
returns more than the limit.


---

# The requirement scale

A `requirement` is a buyer who has **posted** what he needs: an institutional
tender, a GeM bid, or a news-reported opening that the openings lane followed
through to a real contact. The demand lane that produces them is described in
the README.

The score is a sum of four components plus the same "already worked" penalty,
then clamped to 0-100. It is deterministic and makes no model call.

## 1. Deadline proximity (0-30)

Measured from the run date to `extra.deadline`, or to `extra.whyNowDate` when
the requirement carries no separate deadline.

| Band | Points | |
| --- | --- | --- |
| Closes within 7 days | 30 | `within7` |
| 8 to 14 days | 25 | `within14` |
| 15 to 30 days | 18 | `within30` |
| More than 30 days away | 10 | `later` |
| No closing date stated | 8 | `none` |
| The date has passed | 0 | `closed` |

A notice with no stated closing date is still a posted requirement and keeps a
small allowance; it is not treated as if it had closed. A notice that **has**
closed scores zero here, so it can never sit at the top of a morning list
looking urgent. `findDeadline()` in `src/lib/dates.mjs` reads the date: a date
announced by a closing label wins, otherwise the earliest date still in the
future, and a notice carrying only past dates gets no deadline at all.

## 2. Quantity fit (0-25)

What the supplier can actually supply, from `capacity` in the client profile. In
the worked example: the headline commodity up to 1,000 kg/day, everything else
between 20 and 5,000 kg/day.
`quantityFit()` in `src/lib/quantity.mjs` decides the band.

| Band | Points | Meaning |
| --- | --- | --- |
| `within` | 25 | Inside the daily range he supplies today. |
| `unstated` | 12 | The notice states no quantity. That is the notice's silence, not a fault of the lead, so it sits above the ones he cannot fill. |
| `small` | 8 | Real, but below the size at which a quote is worth the trip. |
| `over` | 6 | Larger than he can serve alone. Still a lead - still worth a call - and worth less than one he can fill. |

A quantity becomes kilograms *per day* only when the text states a period.
"1,500 kg" with no period is a real quantity with no rate, and is compared as a
total rather than invented into a daily figure.

## 3. Contact completeness (0-30)

What the notice actually gave us to act on. This is the component the whole lane
exists for.

| Band | Points |
| --- | --- |
| A phone **and** an email | 30 |
| A phone | 26 |
| An email | 18 |
| Only a named person or role, no phone and no email | 6 |
| Nothing | 0 |

A requirement with no contact is still shown - it is still a real posted
requirement - and the digest prints **contact not found yet** rather than an
empty field.

## 4. City and state (0-15)

| Band | Points |
| --- | --- |
| The lead's city matches the city the run was for | 15 |
| Different city, same state | 8 |
| Elsewhere | 0 |

State counts for something because a Karnataka institution outside Bengaluru is
still servable, and a Delhi one is a different conversation.

## Penalty: already worked (-25)

The same rule as the buyer scale: a lead whose status is anything other than
`new` loses 25 points.

## Worked example

The IIT Hyderabad hostel mess notice, on a Bengaluru run, read on 2026-09-11
with the notice closing on the 15th, a stated monthly quantity inside capacity,
and both a phone and an email on the notice:

```
deadline       closes in 4 days      30
quantityFit    within                25
contact        phone and email       30
place          different city,
               different state        0
penalty        status = new           0
                                    ---
score                                 85
```

The same notice with no contact on it at all scores 55, and the digest shows it
below the one that can be rung - which is the ordering the owner's morning
actually wants.

## Section order is not a score

`renderDigest()` prints **Requirements posted** before **Buyers to approach**
whatever the numbers say, and `digestPlans()` in `src/digest.mjs` drops
registration routes first, then buyers one at a time, and only then a
requirement. A posted requirement is the scarcest thing in the digest and is the
last thing to leave it when the WhatsApp character cap bites.
