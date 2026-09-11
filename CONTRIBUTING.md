# Contributing

Thank you for looking. This project has a small number of rules that are not
style preferences - they are why the output can be trusted - and a pull request
that breaks one will be declined however good the code is.

## The rules

1. **Never invent data.** A price with no key is absent, not guessed. A phone
   number that cannot be parsed with confidence is `null`. A tender that could
   not be read is a recorded block, not an empty result. If you find yourself
   writing a fallback value so a field looks populated, stop.

2. **A blocked source stays blocked.** No captcha solving, no login bypass, no
   ignoring a rate limit, and no source whose terms forbid this collection. Read
   `robots.txt` before the first page of any host and obey it. If you add a
   source, add its terms to the table in the README at the same time.

3. **Nothing may reach a buyer.** There is no channel in this codebase that can
   message a lead, and adding one is not a contribution. The only outbound
   address is the owner's own, set by the owner, in the owner's own environment.

4. **The rules decide the score.** The model may write facts - `segment_model`,
   `size`, `deadline`, `confidence`, evidence quotes, an opener line. It may not
   set a score, find a lead, or send anything. A pull request that gives the
   model a number to decide will be declined.

5. **Every write leaves a receipt**, and a refusal leaves one too. If your change
   can move a lead, it appends to the chain.

6. **No secret in a file.** Keys come from the environment. `.env.example`
   carries names and comments only. An API key is redacted out of a URL before it
   reaches a receipt. `npm run validate` fails on a committed key or token, and
   it runs in CI.

7. **Say the honest number.** If a lane found four leads, the README says four.
   Documentation that rounds a result up is a bug of the same kind as one that
   rounds a price up.

## Before you open a pull request

```bash
npm test          # all 335 must pass
npm run validate  # profile, registries, prompt versions, no committed secrets
npm run demo -- --seed
```

CI runs those three on Node 20 and 22.

## Adding a test

New behaviour needs a test. A test must not make a real model call, contact a
real SMTP server or the WhatsApp Cloud API, or touch a live source - the suite is
offline and stays offline. Stub `fetch`, use the fake SMTP server in
`test/fixtures/fake-smtp.mjs`, or add a fixture.

A fixture must say in its own header which kind it is. **Real** means captured
with this project's User-Agent, with the date and the URL recorded, and trimmed
but never edited - and with any personal or business contact detail replaced by a
placeholder, with that replacement stated in the header. **Synthetic** means
written by hand, reproducing the published field and column names so the parser
is exercised, with invented values that must never be shown as real data.

## Editing a prompt

Bump the `version:` in its front matter. The version is part of the model cache
key, so editing the wording without bumping it would serve answers written by the
old prompt. The loader refuses a prompt with no version, and `npm run validate`
refuses two prompts sharing one.

## Style

Plain modern JavaScript, ES modules, Node built-ins. `pg` is the only dependency
and it is loaded lazily; a pull request that adds a dependency needs to argue for
it in the description.

Comments explain *why*, not *what*. The best comments in this codebase name the
real page that broke the code - "a newline is not a phone separator" is worth
more than a paragraph describing a regular expression.

Prose - in the README, in a comment, in a digest line - is plain and factual. No
marketing words, no emoji, no exclamation marks, no absolutes.

## Architecture decisions

Six decisions are recorded in `docs/adr/`. A change that reverses one should add
a new ADR explaining why, rather than quietly editing the old one.
