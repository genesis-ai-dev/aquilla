# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

The SPA (`aquilla-web`), identity (`aquilla-identity`), and sync
(`aquilla-sync-worker`) Workers are connected to Cloudflare Workers Builds.
Environment selection belongs to this repository; the dashboard must not infer
an environment from a missing profile or use a command that can promote a
feature build.

## Dashboard settings

After the shared helper is present on `main`, set both the production and
non-production deploy commands for all three Workers to:

```sh
pnpm run deploy:workers-build
```

Root directories remain `/`, `/auth-worker`, and `/sync-worker`, respectively.
Each directory exposes the same `pnpm run deploy:workers-build` command. The
repository helper requires `WORKERS_CI=1`, reads `WORKERS_CI_BRANCH`, and applies
this policy:

| Branch | Wrangler operation | Named environment | Changes live traffic |
| --- | --- | --- | --- |
| `main` | upload → verify exact version → promote → verify traffic | `production` | Yes, after verification |
| `dev` or `development` | upload → verify exact version | `development` | No |
| Any feature branch | upload → verify exact version | `development` | No |

If `WORKERS_CI=1`, `WORKERS_CI_BRANCH`, or `WORKERS_CI_COMMIT_SHA` is absent,
the command fails without invoking Wrangler.
Feature builds may create preview versions, but they cannot promote a version or
change a live route. Feature previews intentionally share development Hyperdrive
and R2 resources; the verifier ensures they cannot inherit production
bindings.

Until the helper commit reaches `main`, keep these containment commands inline
in the dashboard for `aquilla-web` and `aquilla-identity`:

Production deploy command:

```sh
npx wrangler deploy --env=production
```

Non-production branch deploy command: **leave empty**, and disable "builds for
non-production branches". A connection is bound to one Worker script, so a
non-production build cannot deploy a differently-named Worker — it silently
uploads to the bound (production) script instead. That is how feature-branch
versions once landed on the production SPA Worker. QA gets its own three
connections bound to the development scripts with `dev` as their production
branch.

The unnamed Wrangler profile targets `aquilla-sync-worker-local`, never
`aquilla-sync-worker`. The named production profile runs the repository
branch guard as a Wrangler build hook, so an accidental direct deployment is
rejected before upload unless the checkout is on the authorized branch. The build
hook is defense in depth; Cloudflare Builds must still use the repository-owned
command above.

Actual development promotion remains owned by
`.github/workflows/deploy-workers.yml`, whose branch mapping always passes an
explicit named environment.

Staging was retired on 2026-08-05; its Workers, routes, R2 bucket and Neon
branch are pending manual teardown in the Cloudflare and Neon dashboards.
traffic.

GitHub production deploy jobs also enter the repository's `production`
Environment. GitHub's deployment-branch policy restricts that Environment to
`main`, independently of the workflow mapping.

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
does not promote a version or change production or development route
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
