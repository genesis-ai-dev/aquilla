# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

Explicit operator commands are the intended owner of production, staging, and
development deployments. Neither GitHub pushes nor Cloudflare Git integrations
may automatically deploy live traffic. A Workers Builds Worker-name override can
place a development-bound feature version in a production Worker's version
history even when the repository selected a named development profile. A later
manual promotion can then bypass the branch policy.

## Control-plane cutover

Disable the existing Builds connections before publishing the manual-ownership
workflow change. Use this order:

1. Confirm the authenticated operator can inspect and deploy all three Workers.
2. Put every still-connected build on the repository-owned containment command.
3. Disable automatic Workers Builds for `aquilla-web`, `aquilla-identity`, and
   `aquilla-sync-worker` without deleting Workers, versions, bindings, or routes.
4. Publish the workflow change, merge it to `dev`, and run the complete local
   development deployment from a clean, current `dev` checkout.
5. Verify exact versions, bindings, traffic, routes, and public health.
6. After development validation and promotion to `main`, repeat the same explicit
   production deployment from a clean, current `main` checkout.

Web pull-request previews continue through GitHub Actions on the route-free
`aquilla-web-preview` Worker when hosted runners are available.

While any Builds connection remains enabled during the cutover, set both its
production and non-production deploy commands to the repository-owned command:

```sh
pnpm run deploy:workers-build
```

Root directories remain `/`, `/auth-worker`, and `/sync-worker`, respectively.
Each directory exposes the same `pnpm run deploy:workers-build` command. Clean
identity and sync builds must install both the repository root and the worker
package because they import shared `db/`, `shared/`, and migration modules. The
repository helper requires `WORKERS_CI=1`, reads `WORKERS_CI_BRANCH`, and applies
this policy:

| Branch | Wrangler operation | Named environment | Changes live traffic |
| --- | --- | --- | --- |
| `main` | upload → verify exact version → promote → verify traffic | `production` | Yes, after verification |
| `staging` | upload → verify exact version | `staging` | No |
| `dev` or `development` | upload → verify exact version | `development` | No |
| Any feature branch | upload → verify exact version | `development` | No |

If `WORKERS_CI=1`, `WORKERS_CI_BRANCH`, or `WORKERS_CI_COMMIT_SHA` is absent,
the command fails without invoking Wrangler.
Feature builds may create preview versions, but they cannot promote a version or
change a live route. Feature previews intentionally share development Hyperdrive
and R2 resources; the verifier ensures they cannot inherit production or staging
bindings.

Until the helper commit reaches `main`, keep these containment commands inline
in the dashboard for `aquilla-web` and `aquilla-identity`:

Production deploy command:

```sh
npx wrangler deploy --env=production
```

Non-production branch deploy command:

```sh
if [ "$WORKERS_CI_BRANCH" = staging ]; then npx wrangler versions upload --env=staging; else npx wrangler versions upload --env=development; fi
```

Do not add `--preview-alias "$WORKERS_CI_BRANCH"`; Git branch names may contain
slashes, which are invalid Cloudflare version aliases. Keep
`aquilla-sync-worker` on `pnpm run deploy:workers-build`; it already uses the
repository policy.

The unnamed Wrangler profile targets `aquilla-sync-worker-local`, never
`aquilla-sync-worker`. The named production and staging profiles run the repository
branch guard as a Wrangler build hook, so an accidental direct deployment is
rejected before upload unless the checkout is on the authorized branch. The build
hook is defense in depth; Cloudflare Builds must still use the repository-owned
command above.

Live promotion is owned by an explicit operator running the `deploy:aquilla*`
commands from the matching clean branch. `.github/workflows/ci.yml` is CI and
pull-request-preview only. `.github/workflows/deploy-workers.yml` has no push
trigger; its optional dispatch path uses the same named environments and
exact-version verifier when GitHub-hosted runners are available.

Removing the staging Workers or staging routes is explicitly deferred. This
incident recovery only prevents non-production Workers Builds from changing
traffic.

Explicitly dispatched GitHub production Worker jobs enter the repository's
`production` Environment. GitHub's deployment-branch policy restricts that
Environment to `main`, independently of the workflow mapping.

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
does not promote a version or change production, staging, or development route
traffic. Preview bundles do use development services and data.

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
