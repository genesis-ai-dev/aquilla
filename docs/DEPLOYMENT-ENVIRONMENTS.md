# Deployment environments

This is the canonical environment contract for Aquilla. Environment selection is
explicit; no command or workflow may infer production from a missing Wrangler
profile or fall back from an unknown branch.

## Live environment matrix

| Deployment | Git branch | Wrangler profile | SPA | API host | SPA Worker | Identity Worker | Sync Worker | Neon branch | R2 snapshot bucket |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |
| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |

Each API host exposes `/identity/*` and `/chat/*` through the identity Worker and
`/sync/*` through the sync Worker. Staging is retired from the deployable
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

Production and development deploy scripts refuse to run from any branch except
`main` and `dev`, respectively. Every surface selects `production` or
`development` explicitly. The shared deployer uploads
a version, validates its exact ID and bindings, promotes it, reapplies
routes/triggers, and confirms the same ID owns 100% traffic before public
verification. Identity and sync deploys also run the target Neon schema guard
before publishing.

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
# from the surface directory (auth-worker/, sync-worker/, or the repo root for web)
printf %s "$KEY" | npx wrangler secret put <NAME> --env <production|development>
npx wrangler secret list --env <production|development>   # names only, never values
```

Use `printf %s`, not `echo` — `echo` appends a newline and stores it as part of the
secret, which fails as an opaque upstream `401` rather than a missing-key error.

`config/cloudflare-deployments.json` is the source of truth for which secrets each
Worker requires, and the deployers enforce it: `cloudflare-version-deploy.mjs` verifies
the uploaded version's bindings before promoting it, so a deploy **fails closed** with
`missing required secret binding <NAME>` rather than promoting a Worker that cannot do
its job. Keep this section in step with that manifest — a contract test asserts it.

| Surface | Directory | Worker | Secrets required on that Worker |
| --- | --- | --- | --- |
| Web (production) | `.` (repo root) | `aquilla-web` | `DIARIZATION_MODAL_URL`, `DIARIZATION_PUBLIC_BASE` |
| Web (development) | `.` (repo root) | `aquilla-web-development` | none |
| Identity (production) | `auth-worker` | `aquilla-identity` | `OPENROUTER_API_KEY`, `RESEND_API_KEY`, `SECRET_KEY`, `SYNC_SECRET_KEY`, `FRONTIER_D1_API_TOKEN`, `FRONTIER_D1_DATABASE_ID`, `GITLAB_ADMIN_TOKEN`, `MONDAY_CLIENT_SECRET`, `MONDAY_SIGNING_SECRET` |
| Identity (development) | `auth-worker` | `aquilla-dev-identity` | `OPENROUTER_API_KEY`, `RESEND_API_KEY`, `SECRET_KEY`, `SYNC_SECRET_KEY`, `FRONTIER_D1_API_TOKEN`, `FRONTIER_D1_DATABASE_ID`, `GITLAB_ADMIN_TOKEN` |
| Sync (production) | `sync-worker` | `aquilla-sync-worker` | `SYNC_SECRET_KEY`, `DIARIZATION_MODAL_URL`, `DIARIZATION_PUBLIC_BASE`, `DIARIZATION_SHARED_SECRET`, `INWORLD_API_KEY`, `SEED_VC_TOKEN`, `SEED_VC_URL` |
| Sync (development) | `sync-worker` | `aquilla-sync-worker-dev` | `SYNC_SECRET_KEY` |

`SYNC_SECRET_KEY` signs the `/sync-token` JWTs the sync Worker verifies, so the identity
and sync Workers in the same environment must hold the identical value.

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

## Deployment ownership

Live Aquilla deployments require an explicit human/operator action. No push to
GitHub and no Cloudflare Git integration is authorized to deploy live traffic.
The canonical full-environment entrypoints are the local commands above, run from
a clean checkout whose HEAD exactly matches the corresponding remote branch:

- `main` -> `production`
- `dev` -> `development`

The optional `.github/workflows/deploy-workers.yml` workflow is
`workflow_dispatch`-only. It provides the same explicit, verified web,
identity, and sync path once GitHub-hosted runners are available, and resolves its selected branch
through `scripts/resolve-deployment-target.sh`. Unsupported refs fail before any
schema, build, or deploy step; there is no default environment. Production jobs
enter the GitHub `production` Environment, whose deployment-branch policy admits
only `main`.

Cloudflare Workers Builds owns automatic compile-only pull-request previews through the
dedicated `aquilla-web-preview` Worker. All six production/development Workers
remain disconnected from Git. The preview Worker has no custom domain or live
route. Its build deploys matching auth/sync previews and never promotes a live version or changes
production/development traffic. `versification-tool` remains disconnected
because it has no deployable Wrangler application.

The consolidated `.github/workflows/ci.yml` is `workflow_dispatch`-only. Normal
pull-request and push activity consumes no GitHub-hosted runner minutes. Cloudflare
receives GitHub repository events, runs the repository-owned build commands, and
reports compilation results and preview links back to GitHub. The local pre-push
hook runs a secret scan and the existing commit-based affected E2E selection,
not the full suites. QA tests the published preview; preview success does not
certify automated test results.

Every Workers Builds preview uses its branch's auth and sync code with shared
development Hyperdrive/R2 storage, including builds of `main`. The web Worker's
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

**What to do instead.** Verify the two halves separately rather than end to end:

1. Probe the auth preview directly to prove the route exists and is gated —
   `POST https://<alias>-aquilla-auth-preview.<subdomain>.workers.dev/identity/<path>`
   returns 400 for a malformed body and 401 for a bad bearer.
2. Assert the caller's degradation on the sync preview — the named error code, the
   human approval not being consumed, and any partial work still committing.
3. Cover the success path in worker tests, which stub the bridge and run the real
   HTTP handlers.

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
   Environment branch policy (`main` only).
7. This matrix and the Workers Builds runbook.
8. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
9. The live verifier for production and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
