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
uploader always names `aquilla-web-preview`, always builds the SPA against
development APIs, and never invokes a traffic promotion or trigger deployment.

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
| `aquilla-web-preview` | Any repository branch | development API hosts | lint, tests, build, route-free preview upload | No |

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
version, validates its exact bindings, promotes that exact ID to 100%, reapplies
routes/triggers, verifies traffic, and then checks public health.

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

## Pull-request validation

Connect only `aquilla-web-preview` to `genesis-ai-dev/aquilla`. Configure:

- build command: `pnpm run build:workers-build`
- deploy command: `pnpm run deploy:workers-build`
- root directory: `/`
- non-production branch builds: enabled

The build runs root lint/unit/IDML/schema/build gates, both identity and sync
typecheck/test suites, and the agent-worker typecheck/tests. These independent
lanes run concurrently so the complete gate fits Cloudflare's build-duration
limit; any failed lane fails the whole build. Playwright browsers are not
installed because this gate does not run E2E tests. The deploy step uploads only
a route-free `aquilla-web-preview` version. Slash-named branches are normalized
and hashed into stable lowercase aliases. No preview command can name
`aquilla-web`, `aquilla-web-development`, either identity Worker, or either sync
Worker.

GitHub's removed Actions contexts (`lint`, `typecheck`, `unit`, and `build`)
must not remain required. After the first successful Workers Build establishes
the exact GitHub check name, require that Cloudflare preview check on `dev`; add
the same requirement to `main` only when this configuration reaches `main`.

## Exact-version deployment and verification

The repository deployer writes Wrangler's structured NDJSON output to a temporary
file and extracts the exact uploaded version ID. It validates that version's
bindings before production promotion, promotes only that ID to 100%, applies the
profile's routes and cron triggers, and then requires the same ID at 100% traffic.
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
