# Deployment environments

This is the canonical environment contract for Aquilla. Environment selection is
explicit; no command or workflow may infer production from a missing Wrangler
profile or fall back from an unknown branch.

## Live environment matrix

| Deployment | Git branch | Wrangler profile | SPA | API host | SPA Worker | Identity Worker | Sync Worker | Neon branch | R2 snapshot bucket |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production | `release/YYYY/MM/DD` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |
| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |

Each API host exposes `/identity/*` and `/chat/*` through the identity Worker and
`/sync/*` through the sync Worker. The identity Worker also owns
`/.well-known/oauth-authorization-server/*`, the RFC 8414 discovery location for
its MCP OAuth issuer (`docs/CHATGPT-PLUGIN.md`), and
`/.well-known/openai-apps-challenge`, OpenAI's plugin domain check. Staging is retired from the deployable
application contract; development is the only non-production live environment.

`config/cloudflare-deployments.json` is the machine-readable source for Worker
names, routes, environment-selecting variables, Hyperdrive IDs, R2 buckets, and
required binding names. Contract tests keep all three Wrangler files synchronized
with it. R2 contains media, import sources, and agent artifacts; event and
projection state lives only in Neon Postgres.

## Supported commands

| Target | Deploy all | Verify live |
| --- | --- | --- |
| Production | `pnpm run deploy:aquilla` | `pnpm run verify:live:production` |
| Development | `pnpm run deploy:aquilla:dev` | `pnpm run verify:live:development` |

Production deploy scripts refuse to run from anything but a `release/YYYY/MM/DD`
branch; development deploy scripts refuse anything but `dev`. Every surface selects `production` or
`development` explicitly. The shared deployer uploads
a version, validates its exact ID and bindings, promotes it, reapplies
routes/triggers, and confirms the same ID owns 100% traffic before public
verification. Every surface — web, identity and sync alike — runs the target
Neon schema guard before publishing, so a deployment is one unit: a pending
migration or schema drift stops the SPA upload too, rather than leaving the
site on new front-end code against old Workers and an un-migrated database
(AQU-682/AQU-1157). Each deploy job in `Manual Deploy Workers` therefore carries
the target's `NEON_*` credentials, not just the Cloudflare pair: without them the
guard fails closed on a missing credential instead of reporting the schema state,
which published the SPA while neither Worker could go out (AQU-1539).

**Migrate first, then deploy.** `npm run neon:apply:dev` / `neon:apply:prod`
applies pending `db/postgres/migrations/` files to the target Neon branch; only
then does any deploy command get past its guard. Migrations are never applied
automatically by a deploy path or by an agent — that is a deliberate human step
(`npm run neon:status:dev` / `:prod` is the read-only check the guard runs).

Each file commits together with its `schema_migrations` row, so a migration is
either applied and recorded or neither; a file needing `CREATE INDEX
CONCURRENTLY` takes an explicit non-transactional path and must stay idempotent
(AQU-1877, `scripts/neon-migration-file.ts`). Both paths run under
`lock_timeout` — 5 s by default, `AQUILLA_MIGRATION_LOCK_TIMEOUT` to widen it
for a window where blocking every write to `events`/`cells` is acceptable — so a
migration queued behind a long transaction fails fast instead of holding the
write queue open. **`neon:apply:prod` refuses without a snapshot decision:**
pass `--snapshot` to have it cut a `premigrate-<timestamp>` Neon branch off
production first (instant and copy-on-write, and what you restore from if the
apply goes wrong), or `--no-snapshot` if one already exists. `dev` and `local`
are ungated — they are refreshable by design (`pnpm neon:refresh:dev`). The
refresh first reads `dev` and `production` with its credentials and stops with
the rotation steps if the Neon API rejects them; `NEON_REFRESH_PREFLIGHT_ONLY=1`
(the workflow's `preflight_only` input) runs only that check, which is how a
rotated `NEON_API_KEY` is verified without restoring anything. The
refresh deletes `integration_connections` (and by cascade the Monday board
links) right after the restore, because the copy carries every production
org's encrypted Monday tokens and the dev Worker could otherwise use them
(AQU-1775; `pnpm neon:scrub:dev` runs the same scrub by hand, `--dry-run` to
count first). **The restore copies rows, not blobs**, so every audio take it
brings over points at an R2 object `aquilla-snapshots-dev` does not hold and
playback on `dev.aquilla.app` 404s;
`pnpm neon:copy-dev-audio:dev -- --project <id>` copies that one project's
referenced audio across, `--dry-run` to report first (AQU-2114). It copies only
what the nightly cleanup protects — the same reference queries, shared in
`db/shared/media-refs.ts`, so dev never copies what dev then deletes — needs
`R2_ACCOUNT_ID` plus the AQU-2113 copy key
(`R2_DEV_MEDIA_COPY_ACCESS_KEY_ID` / `R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY`), and
refuses any destination but the dev bucket and any database but the dev branch.

**Audio follows the rows, as its own step.** The restore copies every audio row
and none of the bytes, so the scheduled refresh ends with a `Copy prod audio to
dev` step that runs the copy across every project with media, most recently
active first (AQU-2115, `pnpm neon:copy-dev-audio-all:dev`). It is the LAST step
in the job on purpose: the restore has already succeeded by then, so a copy
failure turns only that step red and `dev.aquilla.app` still shows the data the
restore wrote. The first backfill (~561k objects / 167 GB) is bigger than one
run, so each run takes a wall-clock budget (`DEV_AUDIO_COPY_BUDGET_MINUTES`),
stops at a project boundary, and resumes on the next run — there is no cursor,
only the rule that an object already in dev is never copied twice. Every run
writes its counts to the run page's summary. Two dispatch inputs bracket it:
`preflight_only` copies nothing, and `media_copy_only` copies without restoring
(use it to push the backfill along during the day, or to re-run after a
failure). Without `R2_ACCOUNT_ID` and the AQU-2113 copy key the step prints a
`::warning` and skips, leaving the restore green.

All unnamed Wrangler profiles are local-only, including the SPA, identity, sync,
agent sandbox, and resource proxy Workers. A bare
`wrangler deploy` therefore cannot target a production Worker. Production named
profiles also run the branch guard as a Wrangler custom-build hook, covering
accidental direct `wrangler deploy --env=production` calls. Local live deploys
additionally require a clean worktree whose HEAD matches the current remote branch.

## Worker secrets (per environment)

Secrets attach to a **Worker name**, not to this repository, a branch, or a Wrangler
profile. They are never committed, are not declared in any `wrangler.toml`, and do not
copy between environments: provisioning a key on `aquilla-identity` leaves
`aquilla-dev-identity` without it. Every environment must be provisioned separately,
from that surface's directory:

```bash
# from the repo root — identity and sync only (see "Rotating a secret" for why)
printf %s "$KEY" | pnpm run secrets:rotate <identity|sync> <production|development> <NAME>

# from the surface directory (auth-worker/, sync-worker/, or the repo root for web)
npx wrangler secret list --env <production|development>   # names only, never values
```

Use `printf %s`, not `echo` — `echo` appends a newline and stores it as part of the
secret, which fails as an opaque upstream `401` rather than a missing-key error.

### Rotating a secret (AQU-1361)

**Never rotate an identity or sync secret with bare `wrangler secret put`.** That command
is a one-shot: it patches the live Worker and immediately shifts traffic to a new version
Cloudflare derives from the running one. The derived version keeps the script etag and
every binding — and drops the custom version tag. A dashboard secret edit does the same.
Cloudflare has no setting that stops that untagged version from taking traffic.

**Untagged versions are served, wrongly tagged versions are refused.** Both API Workers'
environment guards (`auth-worker/src/environment-guard.ts`,
`sync-worker/src/environment-guard.ts`) check the plain-text bindings (and, for sync,
`AUTH_WORKER_URL` and `DEPLOYMENT_WORKER_NAME`) on every first-party API request, and
return `503 Worker deployment configuration does not match this API environment` on any
mismatch. A `CF_VERSION_METADATA.tag` that names a different Worker or environment is
also a `503`. A **missing** tag is not: the guard serves the request and logs one
`[environment-guard] … is serving an untagged version` warning per isolate. The guards
used to refuse a missing tag too; that turned secret edits into full outages — dev sync
on 2026-09-22, and every production sign-in on 2026-10-20 after three `wrangler secret
put`s on `aquilla-identity`. The warning in Workers Logs is now the signal that a version
went out outside the repo deployers; recover it as described below.

`scripts/cloudflare-secret-rotate.mjs` is still the supported path, because it keeps a
tagged, verified version live:

```bash
printf %s "$KEY" | pnpm run secrets:rotate sync development SYNC_SECRET_KEY
```

1. **Stage** — `wrangler versions secret put --tag <worker>-<environment>-<sha>` creates a
   new version carrying the rotated secret *and* the deployment tag, without shifting any
   traffic.
2. **Verify** — the staged version's actual bindings are checked against
   `config/cloudflare-deployments.json` (Hyperdrive id, R2 buckets, plain-text vars,
   required secrets) before it can serve. A mismatch aborts with nothing promoted.
3. **Promote** — that exact version id goes to 100%, then `verify-worker-deployment.mjs`
   confirms it is the single active version and `verify-live-environment.mjs` re-checks the
   live endpoints.

The secret value is piped through wrangler's inherited stdin, so it never enters the Node
process, its logs, or its error messages. The script refuses a surface other than
`identity`/`sync`, a name absent from that Worker's required secrets in the manifest, and
any output it cannot parse a version id from. A secret that is live on a Worker but not
listed for that environment — `INWORLD_API_KEY` on `aquilla-sync-worker-dev`, say — is
refused by name: add it to the manifest (and the table above) first, so the manifest stays
the source of truth the deployers enforce. **Web secrets** rotate by re-running
`deploy:aquilla:spa` / `deploy:aquilla:dev:spa` after the `wrangler secret put` — the web
version is verified against an immutable preview origin, which a patched version has none
of.

A rotation that has already gone out the old way keeps serving, but untagged. Bring it
back under the deployers the same way as any untagged version: re-run that surface's verified deployment
(`pnpm run deploy:aquilla:dev:sync`, …), which stages and promotes a properly tagged
version with the new secret value intact.

`config/cloudflare-deployments.json` is the source of truth for which secrets each
Worker requires, and the deployers enforce it: `cloudflare-version-deploy.mjs` verifies
the uploaded version's bindings before promoting it, so a deploy **fails closed** with
`missing required secret binding <NAME>` rather than promoting a Worker that cannot do
its job. Keep this section in step with that manifest — a contract test asserts it.

| Surface | Directory | Worker | Secrets required on that Worker |
| --- | --- | --- | --- |
| Web (production) | `.` (repo root) | `aquilla-web` | `DIARIZATION_MODAL_URL`, `DIARIZATION_PUBLIC_BASE` |
| Web (development) | `.` (repo root) | `aquilla-web-development` | none |
| Identity (production) | `auth-worker` | `aquilla-identity` | `DISCORD_FEEDBACK_WEBHOOK_URL`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`, `SECRET_KEY`, `SYNC_SECRET_KEY`, `FRONTIER_D1_API_TOKEN`, `FRONTIER_D1_DATABASE_ID`, `GITLAB_ADMIN_TOKEN`, `MONDAY_CLIENT_SECRET`, `MONDAY_SIGNING_SECRET`, `OMNI_SHARED_SECRET` |
| Identity (development) | `auth-worker` | `aquilla-dev-identity` | `DISCORD_FEEDBACK_WEBHOOK_URL`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`, `SECRET_KEY`, `SYNC_SECRET_KEY`, `FRONTIER_D1_API_TOKEN`, `FRONTIER_D1_DATABASE_ID`, `GITLAB_ADMIN_TOKEN`, `MONDAY_CLIENT_SECRET`, `MONDAY_SIGNING_SECRET`, `MONDAY_TOKEN_KEY`, `OMNI_SHARED_SECRET` |
| Sync (production) | `sync-worker` | `aquilla-sync-worker` | `SYNC_SECRET_KEY`, `DIARIZATION_MODAL_URL`, `DIARIZATION_PUBLIC_BASE`, `DIARIZATION_SHARED_SECRET`, `INWORLD_API_KEY`, `SEED_VC_TOKEN`, `SEED_VC_URL`, `VOICE_FORGE_TOKEN`, `VOICE_FORGE_URL` |
| Sync (development) | `sync-worker` | `aquilla-sync-worker-dev` | `SYNC_SECRET_KEY`, `VOICE_FORGE_TOKEN`, `VOICE_FORGE_URL` |

`SYNC_SECRET_KEY` signs the `/sync-token` JWTs the sync Worker verifies, so the identity
and sync Workers in the same environment must hold the identical value.

`VOICE_FORGE_URL` and `VOICE_FORGE_TOKEN` point the sync Worker's `/audio/voice-convert`
route at the Modal `voice-forge` speech-to-speech service for character-library voices
(`infra/modal/voice_forge.py`); the token must equal the `VOICE_FORGE_TOKEN` in that
app's `voice-forge-auth` Modal secret. Both sync Workers require them: development
since the character voice library (#1576), production since custom voice training
(#1589) made the forge a production dependency. A Worker without them answers a
library-voice conversion with `503 voice conversion not configured` and a training
start with `503 voice training not configured`; cloned-voice conversions still go to
Seed-VC and are unaffected.

Omnilingual ASR has two backends. `OMNI_ASR_MODAL_URL` is the Modal app
(`infra/modal/omni_asr.py`). `OMNI_ASR_PRIMARY_URL` is an optional self-hosted
server (`infra/selfhost/`, for example a GPU box behind a Cloudflare Tunnel at
`https://omni-asr.aquilla.app`). Both are plain `[vars]` in
`auth-worker/wrangler.toml`, not secrets. When the primary is set, identity
probes its `/healthz` with a 3 s timeout before each call and uses it when it
answers; on a failed probe, a network error, a 60 s timeout or a 5xx it calls
Modal instead. It never retries a 4xx. Each call is billed on the `gpu` name
that the answering backend reports (`db/shared/omni-asr-cost.ts`). Both backends
check the same `OMNI_SHARED_SECRET`: when you rotate it, also update
`/etc/aquilla-omni.env` on the self-hosted box and restart `omni-asr@<user>`,
or the box answers 401 and every call fails (a 401 does not fall back).

`MONDAY_TOKEN_KEY` is development-only (AQU-1775): the Monday token encryption key is
derived from it instead of `SECRET_KEY`, which production and development still share,
so a production org's Monday tokens copied onto the dev Neon branch are unreadable on
dev. Production leaves it unset and keeps the `SECRET_KEY` derivation. Setting or
rotating it makes every Monday connection made on that Worker before it unreadable;
reconnect the orgs afterwards. Set it with the rotation script, never bare
`wrangler secret put`:

```bash
printf %s "$(openssl rand -base64 48 | tr -d '\n')" | pnpm run secrets:rotate identity development MONDAY_TOKEN_KEY
```

### Changing a secret without a redeploy: Secrets Store

The identity and sync Workers can also read a secret from the account's
Cloudflare Secrets Store (`default_secrets_store`,
`74633238cfb84b6a8197a6bd21b2fa21`). A store secret is read at runtime, so
changing its value needs no new Worker version and never trips the
environment guard.

- **Convention.** A Secrets Store binding named `SS_<NAME>` supplies
  `env.<NAME>`. `db/shared/secrets-store-overlay.ts` resolves it at every entry
  point: the identity Hono app, crons, the sync `fetch`/`scheduled`/`queue`
  handlers, and the `ProjectSync`, `ContextualRunDriver` and
  `KnowledgeIndexDriver` Durable Objects.
  Code keeps reading `env.<NAME>` unchanged.
- **The store value wins, and the Worker secret is the fallback.** If the binding
  is absent, the store read fails, or the store returns an empty value, the
  Worker secret of the same name is used. A failed refresh keeps serving the
  last good store value.
- **Live within about a minute.** Values are cached per isolate for 60 s.
- **Store names are per environment:** `aquilla-<environment>-<NAME>`, for
  example `aquilla-production-OMNI_SHARED_SECRET`. The store is account-wide,
  so production and development must not share a name.
- **The deploy gate accepts either.** `verify-worker-deployment.mjs` treats a
  required secret as present when the Worker has `<NAME>` (`secret_text`) or
  `SS_<NAME>` (`secrets_store_secret`).

To move a secret into the store:

1. Create it with `npx wrangler secrets-store secret create
   74633238cfb84b6a8197a6bd21b2fa21 --name aquilla-<env>-<NAME> --scopes workers
   --remote`. Wrangler prompts for the value; pipe it on stdin rather than
   using `--value`.
2. Add the binding to that environment in `<worker>/wrangler.toml`:

   ```toml
   [[env.production.secrets_store_secrets]]
   binding = "SS_<NAME>"
   store_id = "74633238cfb84b6a8197a6bd21b2fa21"
   secret_name = "aquilla-production-<NAME>"
   ```

   The bound secret must already exist, or the deploy fails. The deploy
   credential, whether that is the `CLOUDFLARE_API_TOKEN` used by
   `deploy-workers.yml` or a local `wrangler login`, needs **Account Secrets
   Store Edit**.
3. Ship it with the normal release. After that, change the value in the
   dashboard (Secrets Store → the secret → Edit) or with `wrangler
   secrets-store secret update`. No deploy is needed.

Keep the Worker secret as a fallback while Secrets Store is in beta. Rotating
only the Worker secret has no effect while a store value is bound, so rotate
the store copy.

### The AI provider key (`OPENROUTER_API_KEY`)

Every AI surface in the product is served by the identity Worker and reads this one
secret straight from that Worker's environment — chat (`routes/chat.ts`), the
translation agent and back-translation (`routes/agent.ts`), AI drafting
(`routes/ai-draft-internal.ts`), the contextual pipeline (`routes/contextual.ts`),
brief summaries (`routes/ai-brief-internal.ts`), import classify/sandbox
(`routes/import-classify.ts`, `routes/import-sandbox.ts`), knowledge indexing, and
Monday analysis.

**There is no runtime fallback.** The platform admin console
(`PATCH /api/v2/admin/settings`) tunes model selection, allowed models, A/B split, and
daily spend limits only — it has no field for the key. An unset key is therefore visible
only as a `500 "OPENROUTER_API_KEY is not configured"` from each of those routes, which
is what made the whole AI workflow unusable on `dev.aquilla.app` (AQU-762). Setting it
on one environment does nothing for the other.

## Cutting a release

`dev` is the trunk and targets development. Production ships from dated release
branches cut from `dev`; `main` is retired.

1. `node scripts/release-plan.mjs` decides whether to cut, and names the
   branch, the base (the newest calver tag, which is not on `dev`: it reads
   the tag's cherry-picks to learn which `dev` PRs shipped) and the ready
   PRs to pick onto it, in `dev` order. A PR whose files touch a holding
   risk area, or whose walk is not proven, is skipped until a person adds
   `release:approved` (`docs/RELEASE-RISK-GATES.md`). A release branch may
   carry the plain cut date, `release/YYYY/MM/DD`, or a same-day `-NN`
   suffix for the Nth slice cut that date; both are production branches.
   The **Release cut** workflow runs the plan, builds the branch by
   `git cherry-pick -x` and pushes it on the hour, after every production
   deploy's tag push, or when a person presses its button
   (`e2e/journeys/RELEASE-CUT.md`).
2. The push runs `release-verify` (the full suite) and smart Jev on the
   branch; QA reads the branch's preview as needed.
3. With `HOURLY_RELEASE` on, `release-deploy.yml` runs the step below at
   `:45` once both reported on the branch HEAD with no FAIL. By hand: from
   a clean checkout of that branch, checked out by name (not a detached
   HEAD — the branch guard and the tag script both need it), run
   `pnpm run deploy:aquilla`. After the live checks pass,
   `scripts/tag-release.sh` tags HEAD `YYYY.MM.DD.NN` and pushes the tag. The
   date and the first NN come from the branch: `release/YYYY/MM/DD-02` is
   tagged `YYYY.MM.DD.02`, and a plain `release/YYYY/MM/DD` branch starts at
   `00`. If that number is already taken, the tag takes one past the highest
   in the series. Redeploying an already-tagged commit reuses its tag. The
   annotated tag message includes the release branch, deployed commit SHA,
   GitHub commit/checks URLs, and the Workers Builds preview URL for that
   release branch, tying the production tag back to the QA preview artifact.
4. Hotfix: cherry-pick onto the branch that was deployed, push, and redeploy.
   It gets the next NN in that date's tag series.

Prod lags `dev` by design, so migrations must be backward-compatible across one
release (add first, remove in a later release). Apply the release's migrations
to the target Neon branch *before* step 3 — every surface's deploy guard fails
closed on a pending migration, and nothing publishes until it passes.

## Deployment ownership

Live Aquilla deployments require an explicit human/operator action or one of
the two gated workflows below, and run through the guarded commands above and
nothing else: no Cloudflare Git integration deploys live traffic. Since 2026-10-30
(`docs/RELEASE-RISK-GATES.md`) two workflows may run those same commands
without a person, each only while its repository variable is `on`:
`release-deploy.yml` (`HOURLY_RELEASE`) deploys the verified release branch
on the hour and tags it; `dev-deploy.yml` (`AUTO_DEV_DEPLOY`) deploys `dev`
on every merge after applying dev migrations. With the variables off, or
at any other time, a person runs the local commands from a clean checkout
whose HEAD exactly matches the corresponding remote branch:

- `release/YYYY/MM/DD` -> `production`
- `dev` -> `development`

The optional `.github/workflows/deploy-workers.yml` workflow is
`workflow_dispatch`-only. It provides the same explicit, verified web,
identity, and sync path once GitHub-hosted runners are available, and resolves its selected branch
through `scripts/resolve-deployment-target.sh`. Unsupported refs fail before any
schema, build, or deploy step; there is no default environment. Production jobs
enter the GitHub `production` Environment, whose deployment-branch policy admits
only `release/*/*/*`.

Cloudflare Workers Builds owns automatic compile-only pull-request previews through the
dedicated `aquilla-web-preview` Worker. All six production/development Workers
remain disconnected from Git. The preview Worker has no custom domain or live
route. Its build deploys matching auth/sync previews and never promotes a live version or changes
production/development traffic. `versification-tool` remains disconnected
because it has no deployable Wrangler application.

The consolidated `.github/workflows/ci.yml` runs on pull requests into `dev`
(lint, `i18n:check`, the secret scan, unit tests, worker tests, and
`pnpm neon:check`) and on `workflow_dispatch` (that set, plus typecheck, the
Vite build, Tauri, and the IDML browser suite). It does not deploy. Cloudflare
receives GitHub repository events, runs the repository-owned build commands, and
reports compilation results and preview links back to GitHub. The local pre-push
hook runs a secret scan and the existing commit-based affected E2E selection,
not the full suites. QA tests the published preview; preview success does not
certify automated test results.

Every Workers Builds preview uses its branch's auth and sync code with shared
development Hyperdrive/R2 storage, including builds of release branches. The web Worker's
single repository connection deploys all three using `wrangler preview`.
Repository code converts slash-named branches into a stable, lowercase, hashed
preview name. These previews never replace a live Worker. They are NOT a working
miniature of the stack — a preview sync-worker cannot call a preview auth-worker, and
previews cannot be logged; read "Preview limitations" below before trusting a preview
QA result for anything crossing those two Workers. See the
[Workers Builds runbook](runbooks/cloudflare-workers-builds.md#one-time-preview-setup)
for required runtime secrets and limits of shared development data.

### Preview limitations (AQU-1283/1294 investigation, 2026-09-16)

Previews are branch code on shared development data, but they are **not** a working
miniature of the stack. Two limits are load-bearing and neither is obvious from a
green build.

**A preview Worker cannot call another preview Worker.** `cloudflare-stack-preview.mjs`
deploys auth before sync and hands sync the auth preview's origin as
`AUTH_WORKER_URL`, which is correct on paper. In practice that subrequest returns a
404 (Cloudflare's HTML edge page, not the identity Worker's JSON), deterministically,
on every build. The same aliased URL answers correctly from the public internet — 401
on a bad bearer, 400 on a bad body — so the target is healthy and only the
Worker-to-Worker hop fails. The precise mechanism is unproven; see "why this stays
unproven" below.

Everything crossing that seam is therefore untestable on a preview:

| Caller | Endpoint on auth-worker |
| --- | --- |
| `commands-draft-cells.ts` (`DraftCells`) | `POST /api/v1/ai/agent/internal/draft-cells` |
| `brief-summary-bridge.ts` (`SetBrief` auto-render, `RegenerateBriefSummary`, `ProjectSetup`) | `POST /api/v1/ai/agent/internal/brief-summary` |
| `monday-notify.ts` | `POST /api/v2/monday/internal/push` |

A route that already exists on `dev` masks this, because the failure looks like a
route that is merely absent. AQU-1283's PR was the first to add a NEW internal route
on this seam, which is why it surfaced there and not earlier. Do not read "the preview
404s" as "the code is broken".

**You cannot get logs out of a preview.** Cloudflare documents that preview URLs
support no Workers Logs, no `wrangler tail`, and no Logpush
(<https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/>).
`wrangler preview settings` reads only the shared Previews Base, never a deployed
preview's effective vars. So there is no supported way to observe what a preview
actually resolved a binding to.

**Why this stays unproven.** Combining the two: the failing call is invisible (no
logs) and its configuration is unreadable (no per-preview settings). The leading
explanation is that a subrequest to a preview URL resolves to the bare Worker rather
than the alias — `https://aquilla-auth-preview.<subdomain>.workers.dev` has no
deployment and returns exactly the observed HTML 404, while the aliased host does not
404 under any input. Also note Cloudflare's own limitation that preview URLs "are not
generated for Workers that implement a Durable Object", which sync-worker does
(`ProjectSync`). Proving it needs either Cloudflare support or a throwaway pair of
Workers reproducing the hop outside this repo.

**No Autopilot run driver on a preview (AQU-1845).** auth-worker declares the
per-run `ContextualRunDriver` Durable Object in every real environment, but
`scripts/cloudflare-stack-preview.mjs` deliberately omits it from the auth
preview config — by the same Cloudflare limitation quoted above, a Worker that
implements a Durable Object gets no preview URL, and `previewOrigin` treats a
missing URL as fatal, so declaring it would risk the whole PR preview stack
(the web preview is built from the auth preview's origin). With the binding
absent, `routes/contextual.ts` falls back to the pre-AQU-1845 in-request
`waitUntil` loop. So a preview can show that a run starts, drafts and stages
reviewable work, but it CANNOT show that the run outlives the request that
started it, or that an interrupted run resumes without re-paying for finished
model calls. Walk those on development or production.

**No knowledge-base indexing driver on a preview (AQU-2051).** The same applies
to the per-document `KnowledgeIndexDriver` Durable Object auth-worker declares
for every real environment: the auth preview config carries no binding for it
either, for the reason above. With the binding absent,
`routes/knowledge.ts` `runIndexing` falls back to the request-hosted
`waitUntil` job on `KB_INDEX_BUDGET_MS` — the pre-AQU-2051 path. So a preview
can show that an upload returns at once and that a small document reaches
"Indexed", but it CANNOT show that a large document is summarized fully in one
run, that a long run is never shown as stalled, or that a retry cannot start a
second job over a live one. Walk those on development or production.

**What to do instead.** Verify the two halves separately rather than end to end:

1. Probe the auth preview directly to prove the route exists and is gated —
   `POST https://<alias>-aquilla-auth-preview.<subdomain>.workers.dev/identity/<path>`
   returns 400 for a malformed body and 401 for a bad bearer.
2. Assert the caller's degradation on the sync preview — the named error code, the
   human approval not being consumed, and any partial work still committing.
3. Cover the success path in worker tests, which stub the bridge and run the real
   HTTP handlers.

**A preview recognises one platform admin, and it is a QA fixture (AQU-1353).** A
preview's `ADMIN_EMAILS` is set in `scripts/cloudflare-stack-preview.mjs` to the single
address `qa-admin@local.test` — the QA fixture account on development storage — so the
bots can walk `/admin` instead of reporting `NOT CHECKED` for want of a fixture. Three
properties keep that contained, and a change to any of them is a production auth change:

- The preview config is generated by that script and never reads or writes
  `auth-worker/wrangler.toml`. The operator allowlists on `aquilla-identity` and
  `aquilla-dev-identity` are untouched; `scripts/cloudflare-stack-preview.test.ts`
  asserts no address is shared between the two.
- The allowlist holds exactly one entry and it is not an operator's address, so no
  human identity gains anything from a preview. The fixture sees only the Neon dev
  branch and dev R2 bucket the preview is already bound to.
- Step-up elevation stays `true` on previews, so the real gate runs. Previews declare
  no `send_email` binding, so `POST /admin/elevation/request` returns the code as
  `devCode` (its condition is `ENVIRONMENT !== "production"` **and** no `EMAIL`, both of
  which production fails) and a bot can complete the flow without mail.

The journey is `e2e/journeys/admin-console-platform.md`; the fixture recipe is in
`e2e/journeys/README.md`.

The agent sandbox and not-yet-enabled resource proxy follow the same rule: their
production profiles are main-only, their unnamed profiles have distinct local
names, and the agent package's deploy scripts always select a named environment.

The Cloudflare API token is currently a repository secret, because GitHub cannot
copy an existing secret value into an Environment. For credential-level isolation,
an administrator must re-enter it as `CLOUDFLARE_API_TOKEN` in the `production`
Environment and replace the repository-level token with a non-production-scoped
token. The branch policy, fail-closed resolver, local-only default Worker names,
and Wrangler branch hooks protect deployments independently of that final token
split.

## How to add or remove a platform admin

Platform admins (the cross-tenant console accounts) are rows in the
`platform_admins` table, not Worker config (AQU-1239: the repo is public, so
the list cannot live in `wrangler.toml`). Deployed dev and prod do not set
`ADMIN_EMAILS`; it exists only as a bootstrap for local dev, e2e and
self-hosters.

Rows are written by hand, on purpose: no API route can grant admin. The
`neon:*` scripts only migrate, so connect with `psql` to the target Neon branch
(connection string from the Neon console for the `dev` or production branch):

```sh
psql "$DEV_DATABASE_URL"    # or "$PROD_DATABASE_URL"
```

```sql
-- add (email must be lowercase and trimmed; the table refuses anything else)
INSERT INTO platform_admins (email, added_by, note)
VALUES ('someone@example.com', 42, 'support lead, added per AQU-0000')
ON CONFLICT (email) DO NOTHING;

-- list
SELECT email, added_by, note, created_at FROM platform_admins ORDER BY email;

-- remove (takes effect on that person's next request)
DELETE FROM platform_admins WHERE email = 'someone@example.com';
```

`added_by` is the `users.id` of the admin granting access, or `NULL` if you
leave it out. `note` is free text for why the person has access. An email can
be added before the person signs up; `GET /api/v2/admin/admins` shows it with
`hasAccount: false` until they do.

Order for a first rollout: apply the migration (`neon:apply:dev` /
`neon:apply:prod`), insert the admins, then deploy the auth Worker that no
longer sets `ADMIN_EMAILS`. Deploying first locks everyone out of the console
until the rows exist. If the table is missing the Worker treats nobody as a
table admin and logs `platform_admins read failed`; it does not fail requests.

## Change checklist

An environment change is one atomic contract change. Update and verify all of:

1. The three Wrangler files and their Worker routes/bindings.
2. `package.json` deploy and live-verification commands.
3. Cloudflare Workers Builds settings, `.github/workflows/ci.yml`, and the
   dispatch-only `deploy-workers.yml`.
4. `config/cloudflare-deployments.json`, `cloudflare-version-deploy.mjs`, and
   `verify-worker-deployment.mjs`.
   A new required secret, Worker, or environment must be added to the manifest, the
   "Worker secrets" table above, and provisioned on every affected Worker name before
   that environment is deployed.
5. `scripts/resolve-deployment-target.sh` and `verify-deploy-branch.sh`.
6. GitHub branch protection Cloudflare check contexts and the `production`
   Environment branch policy (`release/*/*/*` only).
7. This matrix and the Workers Builds runbook.
8. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
9. The live verifier for production and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
