# monitor-worker (`aquilla-monitor`)

Uptime checks with Discord alerts. A cron runs every minute, probes each target
in `MONITOR_TARGETS`, and posts to a Discord channel when a target goes **down**,
stays down (**reminder**), or **recovers**.

| Event | When | Mentions the team? |
|---|---|---|
| 🔴 down | `FAILURE_THRESHOLD` (3) failed checks in a row | Yes |
| 🟠 reminder | Every `REMINDER_MINUTES` (60) while still down | Yes |
| 🟢 recovered | `RECOVERY_THRESHOLD` (2) good checks in a row | No |

One failed check never pages anyone. One alert covers one outage; the team is
not pinged each minute.

## What it checks

| Target | Production URL | Healthy when |
|---|---|---|
| Web app | `https://aquilla.app/login` | 200 and the SPA shell (`id="root"`) |
| Identity API | `https://api.aquilla.app/identity/healthz` | 200 and `"ok":true` |
| Sync API | `https://api.aquilla.app/sync/health` | 200 and `"ok":true` — this route runs `SELECT 1` on Postgres and a HEAD on R2 (`sync-worker/src/health-route.ts`) |

The development profile checks the same paths on `dev.aquilla.app` and
`api.dev.aquilla.app`. Edit `MONITOR_TARGETS` in `wrangler.toml` to add more.
Each target takes `id`, `name`, `url`, and optional `expectStatus` (default
200), `expectBodyIncludes` and `timeoutMs` (default 10 000).

## Set up Discord

1. **Make the channel.** Create a private channel, e.g. `#status-alerts`.
2. **Make the webhook.** Channel settings → Integrations → Webhooks → New
   Webhook → Copy Webhook URL.
3. **Make the role to page.** Server settings → Roles → create `@on-call` and
   give it to the people who must get alerts. In the role settings, turn on
   "Allow anyone to @mention this role" — a webhook can ping a role only when
   this is on.
4. **Copy the ids.** User settings → Advanced → turn on Developer Mode. Then
   right-click the role (Server settings → Roles) → Copy Role ID. For single
   people, right-click the user → Copy User ID.
5. **Put the ids in `wrangler.toml`** under the profile's `vars`:
   ```toml
   DISCORD_MENTION_ROLE_IDS = "123456789012345678"
   DISCORD_MENTION_USER_IDS = ""            # optional, comma-separated
   ```
   Ids are not secret. A value that is not a Discord id stops the Worker, so a
   typo cannot turn into an `@everyone` ping.

Discord can send a phone push when a role mentions you, subject to your app
and device notification settings. In
the channel's notification settings, each person should choose "Only
@mentions" so that recovery messages stay quiet.

## Deploy

Deploy the sync-worker change first. Until `/sync/health` is live, the Sync
API target answers 404 and the monitor reports it as down.

```bash
cd monitor-worker
npm ci

# Secrets (once per profile)
npx wrangler secret put DISCORD_WEBHOOK_URL --env development
npx wrangler secret put MONITOR_ADMIN_TOKEN --env development   # optional, for /test-alert
npx wrangler secret put HEARTBEAT_URL --env development         # optional, see below

npm run deploy:development
npm run deploy            # production; refuses to run off a release/YYYY/MM/DD branch
```

Then send a test alert to check the webhook and the mentions:

```bash
curl -X POST https://aquilla-monitor-dev.<subdomain>.workers.dev/test-alert \
  -H "Authorization: Bearer $MONITOR_ADMIN_TOKEN"
```

`/test-alert` does not exist when `MONITOR_ADMIN_TOKEN` is not set.

## Watching the watcher

A monitor that runs on Cloudflare cannot report a Cloudflare outage, or its own
failure. Set `HEARTBEAT_URL` to a heartbeat check in an outside service
(Better Stack, healthchecks.io, or UptimeRobot), and point that service's alerts
at the same Discord channel. The Worker calls the URL at the end of each run,
**only** when the run worked — so the outside service alerts when the monitor
stops, or when it found an outage but could not post to Discord.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /status` | Current state of every target (JSON) |
| `GET /health` | Liveness of this Worker |
| `POST /test-alert` | Send a sample "down" alert (Bearer `MONITOR_ADMIN_TOKEN`) |

## Develop

```bash
npm test           # state machine, probe, Discord payload, tick
npm run type-check
npm run dev        # wrangler dev --test-scheduled; then
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

State lives in one Durable Object (`MonitorState`), not KV: each run reads then
writes the same record, and KV's eventual consistency could replay an old state
and send an alert twice.

## Frontier R&D configuration

Alerts post into private `#aquilla-alerts` in server `1243639358364450876`.
The channel ID is `1564766764347433001`.

- `@aquilla-support`: `1564768432677847051`.
- `@aquilla-admins`: `1564768540450361497`.

Both roles can view the channel. Neither grants server administration.
Ryder (`ryderwishart`) belongs to both roles. Production mentions both roles.
Development keeps mentions empty for routine checks. Set each person's channel
notifications to **Only @mentions**. Recovery messages do not mention roles.

The development Worker exists at
`https://aquilla-monitor-dev.blue-darkness-7674.workers.dev`.
Its schedule stays disabled until development `/sync/health` returns 200.
The webhook and admin token are Cloudflare secrets, never repository values.

## QA deployment handoff

Source branch: `claude/monitor-worker`. The original implementation commit is
`8a555dab9a744d3ebdbae67038882423f6da900b`.

1. Review the branch through a pull request targeting `dev`. Require the
   current-head walk PASS, required checks, and no unresolved review finding.
2. Merge through the normal gate. From a clean checkout of current `origin/dev`,
   deploy the development sync Worker using the repository command:

   ```bash
   npm run deploy:aquilla:dev:sync
   curl --fail-with-body https://api.dev.aquilla.app/sync/health
   ```

3. Verify HTTP 200 and this response shape:

   ```json
   {
     "ok": true,
     "name": "aquilla-sync-worker",
     "checks": { "postgres": "ok", "r2": "ok" }
   }
   ```

   The route performs `SELECT 1` through Hyperdrive and an R2 HEAD read.
   It writes no database or blob data. A failed dependency returns HTTP 503.
   A 404 means this route has not deployed. Existing `/healthz` stays unchanged.
4. QA the release preview, then have the release operator deploy the approved
   dated release branch through the normal release process. For a sync-only
   deployment, the repository command is `npm run deploy:aquilla:sync`.
   Verify `https://api.aquilla.app/sync/health` with the same assertions.
   Record the deployed commit and production calver tag through normal tooling.
5. From that clean, pushed release branch, install the monitor dependencies,
   configure its production secrets, then deploy the monitor:

   ```bash
   cd monitor-worker
   npm ci
   npx wrangler secret put DISCORD_WEBHOOK_URL --env production
   npx wrangler secret put MONITOR_ADMIN_TOKEN --env production
   npx wrangler secret put HEARTBEAT_URL --env production
   npm run deploy
   ```

   A first-time secret upload may offer to create the new Worker. Keep its
   schedule disabled during provisioning until all secrets are configured.
   Verify `/health`, `/status`, and an authenticated `/test-alert` in Discord.
   After three scheduled runs, `/status` must show fresh results for all targets.
6. To enable development monitoring, commit `crons = ["* * * * *"]` under
   `[env.development.triggers]` after its sync route passes, then redeploy
   development. Do not enable it while the route returns 404.

Do not deploy the sync Worker from the feature branch or bypass the branch guard.
Do not change database bindings or enable `WRANGLER_LOCAL` on a deployed Worker.

## External heartbeat checklist

Create a dedicated production check in Healthchecks.io with a one-minute period
and a five-minute grace period. Connect its Discord integration to
`#aquilla-alerts`, and keep an independent email notification enabled.
Store the check's private ping URL as the production `HEARTBEAT_URL` secret.
Use a separate check if development monitoring also needs a heartbeat.

Verify the check receives scheduled pings. Then test a missed heartbeat using a
separate disposable check with the same notification integration. Confirm both
its failure and recovery notifications arrive. Never pause the production
schedule merely to test the heartbeat. Do not mark setup complete until this
external delivery test passes.
