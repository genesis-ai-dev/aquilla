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

Each person gets a phone push from the Discord app when they are mentioned. In
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
