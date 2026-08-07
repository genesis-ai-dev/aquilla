# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

Explicit operator commands own production and development traffic. Cloudflare
Workers Builds owns automatic validation and route-free version uploads. GitHub
provides repository events and displays Cloudflare checks; GitHub-hosted runners
are not used during ordinary pull-request or push activity.

## Control-plane state

Connect `aquilla-web`, `aquilla-identity`, and `aquilla-sync-worker` to the
`genesis-ai-dev/aquilla` repository. Use `/`, `/auth-worker`, and `/sync-worker`
as their root directories, respectively.

| Worker | Build command | Production and preview deploy command |
| --- | --- | --- |
| `aquilla-web` | `pnpm run build:workers-build` | `pnpm run deploy:workers-build` |
| `aquilla-identity` | `pnpm run build:workers-build` | `pnpm run deploy:workers-build` |
| `aquilla-sync-worker` | `pnpm run build:workers-build` | `pnpm run deploy:workers-build` |

Set `main` as the production branch and enable non-production branch builds.
Both dashboard deploy-command fields intentionally use the same repository
helper. The helper requires Cloudflare's `WORKERS_CI`, `WORKERS_CI_BRANCH`, and
`WORKERS_CI_COMMIT_SHA` metadata before invoking Wrangler.

`versification-tool` remains disconnected. It has no deployable Wrangler
application and must not be given a placeholder build command.

## Workers Builds branch policy

| Branch | Binding profile | Operation | Changes live traffic |
| --- | --- | --- | --- |
| `main` | `production` | upload and verify exact version | No |
| `dev` / `development` | `development` | upload and verify exact version | No |
| Feature branches, including slash names | `development` | upload and verify exact version | No |
| Retired staging branch names | `development` | upload and verify exact version | No |

Missing build metadata fails closed. No Workers Builds path calls `wrangler
deploy`, `wrangler versions deploy`, or `wrangler triggers deploy`. Production
and development routes therefore remain controlled by the explicit operator
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

## Pull-request web previews

Cloudflare's Git integration builds each pushed branch and reports a check to the
associated pull request. It supplies native commit and stable branch preview
URLs. The repository does not pass `WORKERS_CI_BRANCH` to `--preview-alias`, so
slash-named branches cannot fail Wrangler alias validation.

Feature-branch web bundles are compiled against development identity, sync, and
chat hosts. Identity and sync feature versions likewise use their named
development profiles. Uploads are verified against the canonical deployment
manifest before Cloudflare reports success and cannot mutate production or
development route traffic.

The required GitHub branch-protection contexts are the proven Cloudflare Workers
Builds checks. Removed GitHub job contexts (`lint`, `typecheck`, `unit`, and
`build`) must not remain required after the Cloudflare checks have reported on a
test pull request.

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

Identity versions also carry a version-metadata binding. Scheduled work requires
the version tag's actual Worker namespace to agree with the environment's
`DEPLOYMENT_WORKER_NAME` before it opens Hyperdrive. This prevents a development
preview manually promoted under the production Worker from running the cron.

## Workers Builds without a Wrangler application

`versification-tool` currently has no deployable Wrangler application. Its Git
connection must remain disconnected so pushes do not trigger automatic Workers
Builds. Do not delete the existing Worker and do not invent a hosting topology
as part of this recovery.

Never refresh the development Neon branch or development R2 buckets while an
environment-crossing incident is under recovery. First compare event IDs and blob
keys against production and reconcile any development-only records.
