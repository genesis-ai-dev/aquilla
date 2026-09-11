# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

Explicit operator commands own production and development traffic. Cloudflare
Workers Builds is disconnected from every live Worker, and GitHub-hosted runners
are not used during ordinary pull-request or push activity.
`aquilla-web-preview` is the only Git-connected Worker; it is dedicated and
route-free.

## Control-plane state

Keep all six live Workers disconnected from Git:

- production: `aquilla-web`, `aquilla-identity`, `aquilla-sync-worker`
- development: `aquilla-web-development`, `aquilla-dev-identity`,
  `aquilla-sync-worker-dev`

Production and development builds and deployments are manual only. A repository
push must not create a Worker version, change dashboard-level displayed
bindings, or promote traffic in either environment.

The route-free Workers Builds helpers fail closed unless Cloudflare provides
`WORKERS_CI`, `WORKERS_CI_BRANCH`, and `WORKERS_CI_COMMIT_SHA`. The preview
deployer uses only `aquilla-web-preview`, `aquilla-auth-preview`, and
`aquilla-sync-preview`. The three named previews share development storage and
never promote a production/development version or deploy live routes.

The identity and sync build wrappers install their package-local lockfiles only
after Cloudflare has installed the root lockfile. This two-level install is
required: their Wrangler entrypoints live in the package directories, while
their TypeScript graphs include shared root modules.

`versification-tool` remains disconnected. It has no deployable Wrangler
application and must not be given a placeholder build command.

## Workers Builds branch policy

| Connection | Branch | Binding profile | Operation | Changes live traffic |
| --- | --- | --- | --- | --- |
| All live Workers | Any | N/A | no automatic build; Git disconnected | No |
| `aquilla-web-preview` | Any repository branch | branch auth/sync previews, development storage | TypeScript/Vite build, three named previews | No |

Both environments and their routes remain controlled by the explicit operator
commands below.

## Explicit deployments

Run live deployments only from a clean checkout whose HEAD exactly equals the
current remote branch:

| Branch | Command | Named environment |
| --- | --- | --- |
| `main` | `pnpm run deploy:aquilla` | `production` |
| `dev` | `pnpm run deploy:aquilla:dev` | `development` |

The branch guard fails before Wrangler if the checkout is dirty, on the wrong
branch, or not at the current `origin/<branch>` commit. The deployer uploads one
version and validates its exact bindings. For web, it then crawls the complete
SPA JavaScript graph on that version's immutable `preview_url`; a missing chunk
or HTML fallback aborts before traffic changes. Marketing documents are deployed
and verified by the separate `aquilla-marketing` repository. Only a verified version is
promoted to 100%, after which the deployer reapplies routes/triggers, verifies
traffic, and checks public health.

Before any SPA version upload, `public/.assetsignore` tells Wrangler to exclude
workstation metadata such as `.DS_Store`, AppleDouble files, `Thumbs.db`, and
`desktop.ini` even when macOS recreates those files inside `dist/`. The
`scripts/verify-deployment-artifacts.mjs` guard fails closed if that native
ignore policy is missing or incomplete. The same guard runs for local live
deployments and route-free pull-request previews. Wrangler Pages has different
ignore semantics, so the branded Codex, Honeycomb, and Context deploy commands
remove the same metadata (and the Workers-only policy file) from `dist/` before
uploading, then fail if any metadata remains.

`.github/workflows/deploy-workers.yml` is an optional
`workflow_dispatch`-only equivalent for web, identity, and sync once hosted
runners are available. It accepts only `main` or `dev`, requires an explicit
Worker selection, runs the relevant build/tests and Neon schema guard, and uses
the same branch-guarded package commands. It has no push trigger.

Staging has been retired from the repository's Wrangler profiles, deployment
manifest, scripts, guards, and public verifier. The staging Workers were removed
separately in Cloudflare. Any retained Neon branch or R2 data is not deployable
application infrastructure and requires its own backup/retention decision before
deletion.

`.github/workflows/ci.yml` and `.github/workflows/deploy-workers.yml` are retained
as explicit `workflow_dispatch` fallbacks. Neither has a `pull_request` or `push`
trigger. Scheduled Neon/content workflows and tag-triggered Tauri releases are
separate operational workloads and are not silently reassigned to Workers Builds.
Playwright smoke on a dedicated Hetzner box is also separate — see
[hetzner-ci.md](hetzner-ci.md). It is `workflow_dispatch`-only until a
self-hosted runner is Idle.

## Pull-request previews

Connect only `aquilla-web-preview` to `genesis-ai-dev/aquilla`. Configure:

- build command: `pnpm run build:workers-build`
- deploy command: `pnpm run deploy:workers-build`
- root directory: `/`
- non-production branch builds: enabled

The build installs auth/sync dependencies and runs `tsc -b`. The deploy command
runs `scripts/cloudflare-stack-preview.mjs` using the root Wrangler version:

1. Create/update auth and sync previews with the same branch-derived name.
2. Read their actual URLs from Wrangler's structured output.
3. Run Vite once with those URLs, then upload the web preview.
4. Update backend callback URLs to the matching web/auth/sync previews.

The first uploads use a non-resolving callback origin until all URLs are known.
An interrupted deployment can leave an incomplete preview; rerun the same branch
build to finish it. The job reports success only after all five uploads finish.
The preview's stable URL stays the same across commits on that branch.

No lint, secret scan, unit/worker suites, IDML gate, or browser tests run inside
Cloudflare. QA tests the published app. A green check confirms compilation and
uploads, not a tested user journey. No GitHub Action is required.

### One-time preview setup

Provision `aquilla-auth-preview` and `aquilla-sync-preview` in the same account.
Keep them disconnected from Git: the web Worker's existing repo integration
coordinates the complete stack. Allow its build token to deploy all three
preview parents. Never grant it access to live Worker routes for this purpose.

Configure runtime secrets in **Previews Base**, not Production, for each parent:

- auth: `SECRET_KEY`, `SYNC_SECRET_KEY`, `ADMIN_SECRET`.
- sync: the same `SYNC_SECRET_KEY` and `ADMIN_SECRET`.
- auth: `OPENROUTER_API_KEY` if QA needs chat/agent features.

Use preview-specific signing/admin keys. The deployment script never reads
local `.dev.vars` or copies production secrets. Enable Preview Deployments URLs
for all three parents. The script fails if Wrangler returns no preview URL.

Generated `previews` configs bind both backends to development Hyperdrive
`53581197ff7a4202a5ed0ef08537d4a6` and `aquilla-snapshots-dev`. This isolates code
and Durable Objects, **not database rows or blobs**. QA should use a separate
project per preview; development and preview sessions of the same project do
not share a Durable Object broadcast namespace. Schema-changing PRs need a
separate database branch. Automatic migrations, legacy identity migration,
cron jobs, outbound email, and local authentication bypasses are not enabled.
Password login uses existing development accounts. Email/invite delivery,
external integrations, and optional agent infrastructure need separate preview
configuration before QA can rely on those journeys.

Before push, `.husky/pre-push` runs `pnpm scan:secrets`, then
`pnpm test:e2e:affected`. The existing selector uses the commits being pushed
and domain sentinels; it does not run the full smoke suite. Git's pushed refs
are preserved for selection, while inherited repository variables are cleared
so test fixtures can safely create their own Git repositories.

Pushes do not run the full root/worker suites, lint, or IDML/schema validation.
Run directly affected unit/worker tests during implementation. The manual CI
workflow retains broader validation when explicitly requested.

Hooks apply only to pushes that execute them: `--no-verify`, `HUSKY=0`, and
API-created commits bypass local validation. Cloudflare still builds these
commits without running tests. QA owns functional review of each preview.
The full smoke suite remains the explicit merge/deploy/release gate.

GitHub's removed Actions contexts (`lint`, `typecheck`, `unit`, and `build`)
must not remain required. After the first successful Workers Build establishes
the exact GitHub check name, require that Cloudflare preview check on `dev`; add
the same requirement to `main` only when this configuration reaches `main`.

## Exact-version deployment and verification

The repository deployer writes Wrangler's structured NDJSON output to a temporary
file and extracts the exact uploaded version ID and immutable preview URL. It
validates that version's bindings before production promotion. Web deployments
also verify the immutable preview's SPA and static assets before any
`wrangler versions deploy` or trigger command can run. It then promotes only
that ID to 100%, applies the profile's routes and cron triggers, and requires the
same ID at 100% traffic.
Run the read-only production checks independently with:

```sh
node scripts/verify-worker-deployment.mjs web
node scripts/verify-worker-deployment.mjs identity
node scripts/verify-worker-deployment.mjs sync
pnpm verify:live:production
```

The deployment verifier runs `wrangler versions view <version-id> --json` before
promotion and `wrangler deployments status --json` afterward. It validates the
canonical manifest in `config/cloudflare-deployments.json`: required non-secret
variables, Hyperdrive and R2 IDs, binding types, and required secret binding names
for each surface and environment. The public verifier
then checks DNS/TLS, exact identity/chat/sync response contracts, and the
deployed SPA bundle's environment targets. A `503` with an
environment-mismatch message means the custom hostname and bindings do not
match.

SPA bundle verification follows only executable ESM imports and Vite's
generated preload table. It deduplicates cycles before scheduling requests and
rejects HTML returned for a JavaScript URL, so package-internal `.js` filenames
and single-page-application fallbacks cannot inflate or poison the crawl. A
high emergency asset ceiling remains configurable for deterministic tests and
still fails closed if a genuinely unbounded import graph is encountered.
The live crawl bypasses stale edge-cache entries and gives a newly promoted
Worker and its asset manifest a bounded three-minute convergence window. It
retries only the lagging SPA document or JavaScript asset rather than restarting
the complete graph crawl. Persistent HTML fallbacks still fail the deployment;
transient route propagation no longer turns a successful upload into a false
terminal error. Immutable preview verification does not retry an HTML fallback:
an immutable version cannot acquire a chunk that was absent from its uploaded
asset manifest, so the deploy fails closed before production traffic changes.
Immutable app previews intentionally contain no marketing documents: those are
built and deployed by `aquilla-marketing`. The pre-promotion app gate therefore
checks only the SPA graph. The post-promotion public check still proves that the
separate marketing Worker owns `/case-studies/come-and-see` and
`/case-studies/biblica` instead of falling through to the app shell.

Identity and sync versions also carry a version-metadata binding. First-party
requests require the version tag's actual Worker namespace to agree with the
environment's `DEPLOYMENT_WORKER_NAME` before opening Hyperdrive. Identity's
scheduled work enforces the same contract before its cron opens Neon. This
prevents a version from another Worker namespace from reaching either database.

## Workers Builds without a Wrangler application

`versification-tool` currently has no deployable Wrangler application. Its Git
connection must remain disconnected so pushes do not trigger automatic Workers
Builds. Do not delete the existing Worker and do not invent a hosting topology
as part of this recovery.

Never refresh the development Neon branch or development R2 buckets while an
environment-crossing incident is under recovery. First compare event IDs and blob
keys against production and reconcile any development-only records.
