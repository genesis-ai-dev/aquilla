# Cloudflare Workers Builds

This runbook implements the Cloudflare Builds section of the canonical
[deployment environment matrix](../DEPLOYMENT-ENVIRONMENTS.md).

The production sync Worker (`aquilla-sync-worker`) is connected to Cloudflare
Workers Builds. Environment selection belongs to this repository; the dashboard
must not contain its own branch-selection shell expression.

## Dashboard settings

For the `aquilla-sync-worker` build connection, set both the production and
non-production deploy commands to:

```sh
pnpm run deploy:workers-build
```

The root directory remains `/sync-worker`. The repository command reads
`WORKERS_CI_BRANCH` and applies this policy:

| Branch | Wrangler operation | Named environment | Changes live traffic |
| --- | --- | --- | --- |
| `main` | `deploy` | `production` | Yes |
| `staging` | `versions upload` | `staging` | No |
| `dev` or `development` | `versions upload` | `development` | No |
| Any feature branch | `versions upload` | `development` | No |

If `WORKERS_CI=1` or `WORKERS_CI_BRANCH` is absent, the command fails without invoking Wrangler.
Feature builds may create preview versions, but they cannot promote a version or
change a live route.

Actual staging and development promotion remains owned by
`.github/workflows/deploy-workers.yml`, whose branch mapping always passes an
explicit named environment.

## Production verification

After a production deploy:

```sh
cd sync-worker
pnpm exec wrangler deployments status --env=production
cd ..
pnpm verify:live:production
```

The active deployment must show the production version at 100%. The live verifier
checks DNS/TLS, exact identity/chat/sync response contracts, and the deployed SPA
bundle's environment targets. A `503` with an environment-mismatch message means
the custom hostname and bindings do not match.

Never refresh the development Neon branch or development R2 buckets while an
environment-crossing incident is under recovery. First compare event IDs and blob
keys against production and reconcile any development-only records.
