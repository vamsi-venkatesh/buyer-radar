# Case study: FarmQuick, Bengaluru

FarmQuick is a B2B fresh-produce supply business in Bengaluru: peeled garlic up
to 1,000 kg a day, broccoli, capsicum, and exotic and regular vegetables, sold to
restaurants, hotels, caterers, retailers, processors and institutions. It is the
reference deployment, and it is the reason this software exists.

The brief was one sentence from the owner. He needed **leads to sell to** - the
buyers' contact, their requirements, whoever posts anywhere, their details - not
just market prices. Everything in the design follows from taking that literally.

All numbers below are from the runs on the days named, recorded in the project
log at the time. Where a number is small, it is printed small.

## What the first real run found

Bengaluru, both lanes, 2026-09-11, on a domestic connection:

| | |
| --- | --- |
| Candidates fetched, then normalised and de-duplicated into the register | 184 -> **240 leads** |
| Of those, carrying a phone number | **144** |
| Price sheet | 42 catalogue items, **21 priced** that day from real Agmarknet commodity names for Karnataka |
| CPPP tender lane | **blocked** - every listing surface was captcha-gated, recorded and not worked around |
| GeM | unreachable from that network; the lane stayed behind its flag |

A later run on the server, against Postgres, held 177 leads and 119 phones -
fewer, because it was a narrower source set, and the difference is visible in the
two runs' evidence bundles rather than argued about.

**240 leads is not 240 customers.** It is 144 numbers the owner can dial, from
sources that permit it, each with a reason to call attached. That is the honest
claim and it is the one the digest makes.

## The demand lane, and the day it found almost nothing

The directory lane was the easy half. The owner's actual ask was the other half:
buyers who have **posted** a requirement.

Fifty-nine institutional buyers were written into a registry - the IITs, IIMs and
NITs, AIIMS and the state hospitals, defence canteens, railway catering, state
civil supplies, meal programmes, municipal corporations, central schools, state
tourism - and each was probed once, for real. What answered:

| | |
| --- | --- |
| Entries in the registry | 59 |
| Reachable, with at least one tender page returning readable text | **15** |
| Of those, publishing a notice matching anything FarmQuick sells | **3** |
| Requirement candidates produced by the run | **4** |
| Of those, carrying a phone or an email on the notice | **1** |

The 44 that did not answer, by cause: 13 were `HTTP 404` - a tender page that had
moved, or a registry written from knowledge rather than from clicking; 12 timed
out at the TCP connect stage; 5 did not resolve; 5 refused the connection (all
five railway zones); 4 failed TLS because the server does not send its
intermediate certificate; 2 answered 403; and **2 were `robots.txt` refusals that
were obeyed** - IRCTC and Mother Dairy both have tender pages and this software
does not read them.

Four requirements, one with a contact, and that contact a departmental address
rather than a named officer. None carried a closing date, because all four
notices had closed in 2024 and 2025 and the date reader refuses to present a past
date as a deadline. Two of the four were the same mess tender published as three
documents, two of them scans this extractor cannot read - and the digest said so
on the row rather than showing an empty field.

That is a bad day's output. It is also the only kind of output worth having: a
lane that looked productive by guessing would tell the owner nothing on the day
there really was something to find.

## What the model was used for, and what it cost

The model stage went live on **2026-09-11** against DeepSeek. In its first real
exercise it made **13 calls for Rs 0.92** - 8,699 input tokens, 568 output -
against a daily cap of Rs 200.

Those 13 calls produced 3 enrichments and 10 openers. Of the 3 enrichments, one
came back at confidence 0.85 and was allowed to move the score; the other two, at
0.6 and 0.2, were stored, shown on the register with their evidence quotes, and
ignored by the scoring rules. The gate is 0.7 and it is not adjustable per lead.

The openers were plain lines with a real fact in them, taken off the business's
own page - the shape the prompt asks for and the rule-based line cannot produce.
Every one was printed in the owner's morning list for him to read out or ignore.
None was sent anywhere, because nothing in this codebase can send to a buyer.

The enrichment prompt was then scored against 30 labelled synthetic pages:
**JSON validity 100%, segment 100%, deadline 100%, size 93.3%, 28 of 30 with
every field correct**, at a mean of 979 input and 90 output tokens, for Rs 3.30
total. Thirty cases is a smoke test and not a benchmark - the caveat is in the
README and it applies here too.

The first attempt at that evaluation read 0 of 30, because the one-off container
it ran in had no internet egress on the internal Docker network. That is recorded
rather than quietly re-run, because a zero from a broken harness and a zero from
a broken prompt look identical in a summary.

## The two-way loop

On **2026-09-11** the owner sent "Hi" to the radar's WhatsApp number. The message
was stored once, answered automatically with the full digest and its price sheet,
and Meta returned `sent` and then `read`. The whole exchange - inbound, reply,
both statuses - is in that day's webhook evidence bundle, and the bundle verifies.

Getting there was not one step. A production sender had to be verified under the
business account; a first attempt failed with Meta error `131030` because the
recipient was not yet on the allowed list; a later free-text reply failed with
`131047`, the 24-hour re-engagement rule, which is why the dashboard now shows
how long the free-text window has left and falls back to an approved template
after it. An earlier batch of failures was not Meta's fault at all - it was a
`+91` normalisation bug on our side, and it is now a test.

The loop the owner actually uses is the other direction: the digest numbers the
leads `R1..Rn` and `L1..Ln`, and he replies `L3 contacted spoke to the purchase
manager`. That reply moves the lead, appends a dated note, writes its own
verifiable receipt, and drops the lead 25 points so it stops competing with
genuinely new leads tomorrow. A message from any number other than his is
recorded and never answered.

## What running it for real caught

Every one of these was found by pointing green, unit-tested code at real pages,
and none would have shown up against a synthetic fixture. All are now pinned by
tests.

1. **"mess" matched inside "message".** The digest led with three requirements
   called *Director's message*. Keywords are anchored on word boundaries now.
2. **Three notices from one institution merged into one lead.** They shared a
   name, a city and a switchboard number, so both dedup keys collapsed them - and
   the merged row claimed its document was unreadable while displaying a contact
   lifted from a different document. A requirement is now identified by its own
   notice and nothing else.
3. **The e-procurement helpdesk was offered as the buyer.** Practically every
   Indian tender PDF ends with "in case of any difficulty contact eproc@nic.in".
   Portal addresses are dropped, and a notice carrying nothing else has no
   contact.
4. **A date parsed as a phone number.** A PDF schedule laid out one table cell per
   line, and `22.05.2024`, `1` and `5` glued into a ten-digit run that normalised
   to a plausible mobile number nobody has. A newline is not a phone separator. A
   wrong number in the digest is the one failure this project cannot afford.
5. **A page footer offered as a person.** "Registrar" appeared, the next token was
   "Page" from the footer, and the extractor offered *Page* as the person to ask
   for. A name is now an honorific plus something, or two capitalised words, or a
   recognised designation.
6. **A run that never finished.** The request deadline covered the headers and not
   the body, so a server that sent its headers and then went quiet left the read
   pending with nothing to interrupt it - and because the pool waits for every
   lane, one such host stopped the whole run with no error and no log line. Both
   fetchers now hold the deadline across the read.
7. **The digest squeezed the wrong section.** The layout cascade clipped
   requirements to two lines while sparing six buyers their full blocks. A posted
   requirement is the scarcest thing in the digest, so the cascade now exhausts
   the buyer section entirely before narrowing a requirement at all.

## What it is worth

The product is one message, once a morning, that a busy owner reads on his phone
between other things. Everything above exists to make the four or five lines in
that message true.

The thing to take from this case study is not the 240. It is that on the day the
demand lane found one contactable requirement, the digest said so.
