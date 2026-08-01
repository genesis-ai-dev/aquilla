# Deployment environments

This is the canonical environment contract for Aquilla. Environment selection is
explicit; no command or workflow may infer production from a missing Wrangler
profile or fall back from an unknown branch.

## Live environment matrix

| Deployment | Git branch | Wrangler profile | SPA | API host | SPA Worker | Identity Worker | Sync Worker | Neon branch | R2 snapshot bucket |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production | `main` | `production` | `https://aquilla.app` | `api.aquilla.app` | `aquilla-web` | `aquilla-identity` | `aquilla-sync-worker` | `production` | `aquilla-snapshots` |
| Staging | `staging` | `staging` | `https://staging.aquilla.app` | `api.staging.aquilla.app` | `aquilla-web-staging` | `aquilla-staging-identity` | `aquilla-sync-worker-staging` | `staging` | `aquilla-snapshots-staging` |
| Development | `dev` | `development` | `https://dev.aquilla.app` | `api.dev.aquilla.app` | `aquilla-web-development` | `aquilla-dev-identity` | `aquilla-sync-worker-dev` | `dev` | `aquilla-snapshots-dev` |

Each API host exposes `/identity/*` and `/chat/*` through the identity Worker and
`/sync/*` through the sync Worker. `api.staging.aquilla.app` is the correct staging
hostname; `api.dev.aquilla.app` is development and must not be used as a staging
fallback.

The Hyperdrive IDs are intentionally kept in the Wrangler files rather than
duplicated here. A named profile binds its matching Neon branch. R2 contains media,
import sources, and agent artifacts; event and projection state lives only in Neon
Postgres.

## Supported commands

| Target | Deploy all | Verify live |
| --- | --- | --- |
| Production | `pnpm run deploy:aquilla` | `pnpm run verify:live:production` |
| Staging | `pnpm run deploy:aquilla:staging` | `pnpm run verify:live:staging` |
| Development | `pnpm run deploy:aquilla:dev` | `pnpm run verify:live:development` |

Production and staging deploy scripts refuse to run from any branch except `main`
and `staging`, respectively. Every surface passes `--env=production`,
`--env=staging`, or `--env=development` explicitly and verifies the public
deployment afterward. Identity and sync deploys also run the target Neon schema
guard before publishing.

## Automation policy

GitHub Actions deploys only these mappings:

- `main` -> `--env=production`
- `staging` -> `--env=staging`
- `dev` -> `--env=development`

Cloudflare Workers Builds must run `pnpm run deploy:workers-build` for both its
production and non-production commands. That repository-owned command deploys
`main` to production, but uploads preview-only versions for `staging`, `dev`, and
feature branches. It fails closed when Cloudflare does not provide the branch.

Never paste a branch-selection shell expression into the Cloudflare dashboard and
never use a bare `wrangler deploy` for a live Aquilla environment.

## Change checklist

An environment change is one atomic contract change. Update and verify all of:

1. The three Wrangler files and their Worker routes/bindings.
2. `package.json` deploy and live-verification commands.
3. `.github/workflows/deploy.yml` and `deploy-workers.yml`.
4. `sync-worker/scripts/cloudflare-build-deploy.mjs`.
5. This matrix, [Staging](STAGING.md), and the Workers Builds runbook.
6. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
7. The live verifier for production, staging, and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
