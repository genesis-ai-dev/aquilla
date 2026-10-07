# Monday.com integration

Pushes each project's progress into a Monday.com board. Built in AQU-506,
moved onto the generic `integration_*` tables in AQU-683, fixed up in AQU-1770.
This is the short contract the code comments point at; the code is the
detail.

## Shape

- **One connection per org.** An org owner or maintainer connects one Monday
  account from Org settings → Monday.com (`/orgs/:orgId/settings/monday`).
  The OAuth 2.1 + PKCE token is stored AES-GCM encrypted in
  `integration_connections` (`provider = 'monday'`) and never reaches the
  browser.
- **One board link per project.** A project maintainer links one board in
  Project settings → Integrations (`MondayIntegrationSection`). The link is a
  row in `integration_links`; `config` is a `MondayMapping` (below),
  `remote_state` is the board structure last read from Monday,
  `remote_state_stale` drives the "Board structure changed" banner, and
  `webhook_ids` are the board webhooks Aquilla created.
- **Items.** `integration_item_links` remembers which Monday item holds which
  project (or file). Pushes update those items and create missing ones.

## Mapping (`MondayMapping`, `config` on `integration_links`)

Defined twice, kept in lockstep: `auth-worker/src/lib/monday/types.ts` and
`src/lib/monday/types.ts`.

- `itemGranularity`: one item for the project, or one per file.
- `columns`: Monday column id → Aquilla metric (`completion_pct`,
  `validated_pct`, `audio_validated_pct`, counts, `translators`,
  `last_activity`, `status_auto`, `project_name`, `external_id`).
- `matchExisting`: how a push finds items Aquilla made before when it has no
  `integration_item_links` row for them (`{ columnId }` or `{ byName: true }`).
  Whenever the board has an Aquilla ID column (one mapped to `external_id`, or
  a text column titled "Aquilla ID"), the server maps it and matches on it,
  whatever was proposed, so setting up again reuses the items.

Every mapping, from the AI or a person, goes through `sanitizeMapping`, which
drops (with a warning, never a hard failure) unknown metrics, read-only column
types, metric/type mismatches and columns the board doesn't have. Link saves
(`PUT`) and mapping changes (`PATCH` with `config`) check against the board's
columns read from Monday at that moment, and save that read as `remote_state`.

## Routes (identity worker, `/api/v2/monday`)

Listed at the top of `auth-worker/src/routes/monday.ts`. The ones with a
contract beyond "maintainer can, member can view":

- `POST /orgs/:orgId/connection/start { backTo }` returns Monday's authorize
  URL. `backTo` must be an app path; it defaults to the org's Monday settings.
- `GET /oauth/callback?code&state` is called by the SPA page at
  `/oauth/callback` (Monday's registered redirect URI). It answers
  `{ ok: true, backTo }` or `{ ok: false, reason }` with `reason` one of
  `missing_params`, `bad_state` (state expired after 10 minutes, reused or
  tampered), `token_exchange_failed`, `internal`. The SPA shows each as a plain
  sentence (`src/lib/monday/oauth-return.ts`) and tells the tab that opened
  Monday how it ended.
- `PUT /projects/:projectId/link` and `PATCH /projects/:projectId/link` return
  `{ link, warnings }`. Both settings paths (the manual one and "Set up with
  AI") show the warnings.
- `POST /projects/:projectId/sync` pushes now. It refuses (409) while the
  link's Sync switch is off.
- `POST /webhook` is Monday's board webhook (JWT signed with
  `MONDAY_SIGNING_SECRET`): a new column marks the link stale, a deleted or
  archived item forgets its `integration_item_links` row.
- `POST /internal/push` is sync-worker's nudge after an edit. A push runs at
  once if the last one was over 2 minutes ago, otherwise the link is marked
  dirty and the 5-minute cron flushes it.

## Deploying

### Webhook address (AQU-1770)

When a project is linked to a board, the identity Worker asks Monday to create
board webhooks that call back `<BASE_URL_API>/api/v2/monday/webhook`. Monday
first POSTs a challenge to that address and refuses to create the webhook unless
the challenge is echoed back.

`BASE_URL_API` must therefore be the identity API host, not the website:

| Environment | `BASE_URL_API` |
| --- | --- |
| production | `https://api.aquilla.app/identity` |
| development | `https://api.dev.aquilla.app/identity` |
| local / previews / e2e | unset: falls back to `MCP_OAUTH_ISSUER`, then to the address the Worker was reached on |

The website (`BASE_URL`, e.g. `https://dev.aquilla.app`) answers the challenge
with 405. Before AQU-1770 the fallback was `BASE_URL`, and `BASE_URL_API` was set
nowhere, so every link on dev and production saved with the warning "could not
create Monday webhooks…" and no webhooks.

Links saved before this ships have an empty webhook list. Saving such a link
again (project settings → Monday → save the mapping) creates the webhooks, because
the link route creates them whenever the stored list is empty. Unlinking and
linking again also works. No data migration is needed.
