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
`/sync/*` through the sync Worker. There are exactly two live environments.
Staging was retired on 2026-08-05: it tracked a branch nobody pushed to, and
`dev.aquilla.app` already covers pre-production integration testing.

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

The production deploy scripts refuse to run from any branch except `main`. Every
surface selects `production` or `development` explicitly. The shared deployer uploads a version, validates its
exact ID and bindings, promotes it, reapplies routes/triggers, and confirms the
same ID owns 100% traffic before public verification. Identity and sync deploys
also run the target Neon schema guard before publishing.

All unnamed Wrangler profiles are local-only, including the SPA, identity, sync,
agent sandbox, and resource proxy Workers. A bare
`wrangler deploy` therefore cannot target a production Worker. The production
named profile also runs the branch guard as a Wrangler custom-build hook,
covering accidental direct `wrangler deploy --env=...` calls. Local live deploys
additionally require a clean worktree whose HEAD matches the current remote branch.

## Automation policy

**Cloudflare Workers Builds performs every deploy.** GitHub Actions deploys
nothing: this repository exhausts its Actions allowance in roughly a week, and
Cloudflare already holds the credentials (`NEON_API_KEY`) the schema guard needs.

There is one Workers Builds connection per Worker script — six in total, because
a connection is bound to a single script and cannot deploy a differently-named
one. Attempting it produces `Failed to match Worker name ...` and silently
uploads to the bound script instead, which is how feature-branch versions once
landed on the production SPA Worker.

| Connection's script | Production branch | Root | Deploy command |
| --- | --- | --- | --- |
| `aquilla-web` | `main` | `/` | `npx wrangler deploy --env=production` |
| `aquilla-identity` | `main` | `/auth-worker` | `npx wrangler deploy --env=production` |
| `aquilla-sync-worker` | `main` | `/sync-worker` | `npx wrangler deploy --env=production` |
| `aquilla-web-development` | `dev` | `/` | `npx wrangler deploy --env=development` |
| `aquilla-dev-identity` | `dev` | `/auth-worker` | `npx wrangler deploy --env=development` |
| `aquilla-sync-worker-dev` | `dev` | `/sync-worker` | `npx wrangler deploy --env=development` |

Every connection has **builds for non-production branches disabled** and an empty
non-production deploy command. That is the control that keeps `main` the only
thing able to touch a production Worker, and `dev` the only thing able to touch a
QA Worker. No other branch builds at all.

The identity and sync build commands run `pnpm neon:status:prod` (production) or
`pnpm neon:status:dev` (QA) before the worker's own type-check and tests, so a
schema behind `db/postgres/migrations/` fails the build instead of shipping code
that queries missing columns. Both need `NEON_API_KEY` as a build secret.

Never paste a branch-selection shell expression into the Cloudflare dashboard;
branch logic belongs in `scripts/ci-build.sh` and the Wrangler profiles, where it
is version-controlled and covered by contract tests. Never use a bare
`wrangler deploy` for a live Aquilla environment.

GitHub Actions runs `.github/workflows/ci.yml` on pull requests only: lint,
typecheck, unit, build, the migration lint, and the three worker suites when
their package changed. It holds no Cloudflare credentials and there is no
push trigger — a merge would only re-run checks the pull request already paid
for, and Cloudflare re-runs type-check and the worker suites before deploying.

The agent sandbox and not-yet-enabled resource proxy are deployed by hand: their
production profiles are main-only and their unnamed profiles have distinct local
names.

## Change checklist

An environment change is one atomic contract change. Update and verify all of:

1. The three Wrangler files and their Worker routes/bindings.
2. `package.json` deploy and live-verification commands.
3. The six Cloudflare Workers Builds connections (deploy command, build command,
   root directory, production branch, non-production builds disabled).
4. `config/cloudflare-deployments.json`, `scripts/cloudflare-version-deploy.mjs`,
   and `verify-worker-deployment.mjs`.
5. `scripts/ci-build.sh` and `verify-deploy-branch.sh`.
6. This matrix and the Workers Builds runbook.
7. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
8. The live verifier for production and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
