# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

Explicit operator commands own production and development deployments. Neither
GitHub pushes nor Cloudflare Git integrations may automatically deploy live
traffic. Pull requests may publish only a route-free preview version.

## Control-plane state

The Git connections for `aquilla-web`, `aquilla-identity`, and
`aquilla-sync-worker` are disconnected. `versification-tool` was already
disconnected. The cutover did not delete or alter the existing Workers, versions,
bindings, routes, or traffic allocations, and production verification passed
after the change.

Do not reconnect a Git repository or add a dashboard deploy command. The former
`deploy:workers-build` helper and Cloudflare-specific build script were removed
with the connections so they cannot become a second deployment owner later.

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

Web pull-request previews continue through GitHub Actions on the route-free
`aquilla-web-preview` Worker when hosted runners are available.

## Pull-request web previews

Every non-draft web pull request uploads the current commit to the route-free
`aquilla-web-preview` Worker with the sanitized alias `pr-<number>`. Draft and
documentation-only pull requests remain excluded. The alias is refreshed on
every supported pull-request update; no commit-message tag is required.

`scripts/cloudflare-pr-preview.mjs` reads Wrangler's structured NDJSON output
and accepts only a `preview_alias_url` for the expected alias and Worker name.
It does not scrape a display log or hard-code the account's Workers subdomain.
If the preview Worker is missing, the helper may bootstrap only the `preview`
Wrangler profile, which explicitly enables preview URLs and declares no custom
routes, then retry the version upload.

Before the URL is posted to the pull request, the live verifier loads `/app`
through that exact preview origin, crawls the deployed JavaScript graph, and
requires the development identity, sync, and chat targets. This preview process
does not promote a version or change production or development route traffic.
Preview bundles do use development services and data.

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
