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

`config/cloudflare-deployments.json` is the machine-readable source for Worker
names, routes, environment-selecting variables, Hyperdrive IDs, R2 buckets, and
required binding names. Contract tests keep all three Wrangler files synchronized
with it. R2 contains media, import sources, and agent artifacts; event and
projection state lives only in Neon Postgres.

## Supported commands

| Target | Deploy all | Verify live |
| --- | --- | --- |
| Production | `pnpm run deploy:aquilla` | `pnpm run verify:live:production` |
| Staging | `pnpm run deploy:aquilla:staging` | `pnpm run verify:live:staging` |
| Development | `pnpm run deploy:aquilla:dev` | `pnpm run verify:live:development` |

Production and staging deploy scripts refuse to run from any branch except `main`
and `staging`, respectively. Every surface selects `production`, `staging`, or
`development` explicitly. The shared deployer uploads a version, validates its
exact ID and bindings, promotes it, reapplies routes/triggers, and confirms the
same ID owns 100% traffic before public verification. Identity and sync deploys
also run the target Neon schema guard before publishing.

All unnamed Wrangler profiles are local-only, including the SPA, identity, sync,
agent sandbox, and resource proxy Workers. A bare
`wrangler deploy` therefore cannot target a production Worker. The production and
staging named profiles also run the branch guard as a Wrangler custom-build hook,
covering accidental direct `wrangler deploy --env=...` calls. Local live deploys
additionally require a clean worktree whose HEAD matches the current remote branch.

## Automation policy

GitHub Actions deploys only these mappings:

- `main` -> `production`
- `staging` -> `staging`
- `dev` -> `development`

Both deploy workflows resolve this mapping through
`scripts/resolve-deployment-target.sh`. Unsupported live refs fail before any
schema, build, or deploy step; there is no default environment. Production deploy
jobs enter the GitHub `production` Environment, whose deployment-branch policy
admits only `main`. This is a server-side backstop independent of the workflow's
branch resolver.

Cloudflare Workers Builds for the SPA, identity, and sync Workers must run
`pnpm run deploy:workers-build` for both their production and non-production
commands. That repository-owned command verifies the exact uploaded version,
then promotes `main` to production. `staging`, `dev`, and feature branches remain
verified preview-only versions; all feature branches intentionally share the
development resources. It fails closed when Cloudflare does not provide Workers
CI branch and commit metadata. Production binding verification happens before
promotion, with exact-version traffic verification afterward.

Never paste a branch-selection shell expression into the Cloudflare dashboard and
never use a bare `wrangler deploy` for a live Aquilla environment.

Pull requests use the route-free `preview` Wrangler profile
(`aquilla-web-preview`) with development API targets. Preview uploads cannot mutate
the production, staging, or development SPA Workers.

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
3. `.github/workflows/deploy.yml` and `deploy-workers.yml`.
4. `config/cloudflare-deployments.json`, `scripts/cloudflare-build-deploy.mjs`,
   `cloudflare-version-deploy.mjs`, and `verify-worker-deployment.mjs`.
5. `scripts/resolve-deployment-target.sh` and `verify-deploy-branch.sh`.
6. The GitHub `production` Environment branch policy (`main` only).
7. This matrix, [Staging](STAGING.md), and the Workers Builds runbook.
8. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
9. The live verifier for production, staging, and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
