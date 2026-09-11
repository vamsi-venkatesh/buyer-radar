# First run on a server

Twelve steps, in this order. Step 12 is last on purpose.

1. **Check Node.** `node --version` must be 20 or newer. Nothing else is
   required to run the pipeline.

2. **Write the client profile.** `cp config/client.example.json config/client.json`
   and edit it: the business, its capacity, its cities, its catalogue, its
   keywords, the lines the owner would actually say. Put a real contact address
   in `business.userAgent` - every source you read is entitled to know who is
   reading it. Then `npm run validate`.

3. **Create the environment.** `cp .env.example .env` and fill it in. At minimum
   set `RADAR_OWNER_TOKEN`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

   Leave `RADAR_SMTP_URL` and the `WA_*` variables empty on the first day. The
   digest goes to `outbox/` and you can read it there before anything is sent.

4. **Decide the store.** Leave `DATABASE_URL` unset for the JSON store under
   `data/` - no database, no install. Set it for Postgres; the tables are created
   on first run.

5. **Get a prices key** (optional). Register at data.gov.in and put the key in
   `DATA_GOV_IN_KEY`. Without it the agmarknet source is skipped with a recorded
   reason and the price sheet says *no mandi quote*. Nothing is guessed.

6. **Run the tests.** `npm test` - all of them must pass before you point
   anything at a live source.

7. **Probe the institutional registry once.** `node tools/probe-institutions.mjs`
   writes `config/institutional-buyers.probe.json`: what answered *this machine*,
   on *this day*. An entry that answered nothing is skipped on the daily run
   rather than asked again every morning, and re-running the probe is what
   un-marks it. The file is git-ignored, because it is a local result and not a
   fact about the world.

8. **Do one dry run.**
   `node src/run.mjs --city <city> --sources news --limit 20 --dry` - it fetches,
   normalises and scores but writes nothing at all, and never calls the model.

9. **Do one real run.** Drop `--dry`. Read `digests/<date>.txt`, then verify the
   bundle: `node tools/verify.mjs runs/<runId>.evidence.json`.

10. **Check the schedule before you start it.** `node src/cron.mjs --print` prints
    the next three run times in both the configured zone and UTC. If they are not
    what you expect, fix `RADAR_RUN_AT` and `RADAR_TZ` now.

11. **Own the directories and bring it up.** The container runs as uid 1000.

    ```bash
    mkdir -p data runs digests exports reports outbox
    sudo chown -R 1000:1000 data runs digests exports reports outbox
    docker compose -f docker-compose.radar.yml up -d --build
    docker compose -f docker-compose.radar.yml logs -f radar-cron   # expect "[cron] next run ..."
    ```

    Put a TLS reverse proxy in front of `127.0.0.1:4710`, then open
    `https://<host>/login?t=<RADAR_OWNER_TOKEN>` once on the phone. Check that
    `/`, `/leads`, `/prices`, `/runs` and `/report/weekly` all load, and that `/`
    without the cookie is a **401**.

12. **Turn delivery on last**, once you have read a few days of `outbox/` files
    and are happy with what they say. Set `RADAR_TO`, `RADAR_SMTP_URL` and/or the
    `WA_*` variables, set `RADAR_DELIVER`, and restart `radar-cron`.

## The WhatsApp webhook

Meta delivers inbound messages and delivery statuses to `${RADAR_BASE_PATH}/webhook`
on the dashboard. It is the only route the owner token does not guard - Meta
cannot present one - so what stands in its place is the app-secret signature on
every POST body.

In the Meta app dashboard, under WhatsApp -> Configuration:

1. **Callback URL** `https://<host>/<base path>/webhook`
2. **Verify token** the value of `WA_VERIFY_TOKEN`
3. Press Verify and save. Meta sends
   `GET ...?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`; the route
   answers `200` with the raw challenge as `text/plain`, or `403` on any other
   token. With `WA_VERIFY_TOKEN` unset it answers `503`.
4. **Subscribe to the `messages` field.** Nothing else is read.

With `WA_APP_SECRET` unset the POST route answers `503` and accepts nothing: an
unsigned event is never trusted. Meta will not deliver to a plain-HTTP callback,
so TLS is not optional here.

## Operating it

```bash
node src/cron.mjs --print                  # the next three run times
node src/cron.mjs --once                   # one pass now, then exit
node src/register.mjs list --status new --limit 20
node src/register.mjs set-status L3 contacted "spoke to the purchase manager"
node src/register.mjs export --csv
node src/report.mjs --week 2026-W37
node tools/verify.mjs runs/webhook_$(date +%F).evidence.json
node src/tools/cli.mjs list
```

`L<n>` resolves against the most recent digest; a raw lead id also works and is
unambiguous later. Every status change appends a dated note, writes a verifiable
receipt, and drops that lead 25 points so it stops competing with new ones.

## Storage

With `DATABASE_URL` set, leads, runs and events go to Postgres; tables are
created on first run. Without it everything goes to `data/leads.json`,
`data/runs.json` and `data/events.json`. Both stores expose the same interface
and are covered by the same tests, so the pipeline and the CLI behave identically
either way. The JSON store is for one process; it is not a small database and is
not documented as one.
