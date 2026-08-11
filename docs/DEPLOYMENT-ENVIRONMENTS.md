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
`/sync/*` through the sync Worker. Staging is retired from the deployable
application contract; development is the only non-production live environment.

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

Production and development deploy scripts refuse to run from any branch except
`main` and `dev`, respectively. Every surface selects `production` or
`development` explicitly. The shared deployer uploads
a version, validates its exact ID and bindings, promotes it, reapplies
routes/triggers, and confirms the same ID owns 100% traffic before public
verification. Identity and sync deploys also run the target Neon schema guard
before publishing.

All unnamed Wrangler profiles are local-only, including the SPA, identity, sync,
agent sandbox, and resource proxy Workers. A bare
`wrangler deploy` therefore cannot target a production Worker. Production named
profiles also run the branch guard as a Wrangler custom-build hook, covering
accidental direct `wrangler deploy --env=production` calls. Local live deploys
additionally require a clean worktree whose HEAD matches the current remote branch.

## Deployment ownership

Live Aquilla deployments require an explicit human/operator action. No push to
GitHub and no Cloudflare Git integration is authorized to deploy live traffic.
The canonical full-environment entrypoints are the local commands above, run from
a clean checkout whose HEAD exactly matches the corresponding remote branch:

- `main` -> `production`
- `dev` -> `development`

The optional `.github/workflows/deploy-workers.yml` workflow is
`workflow_dispatch`-only. It provides the same explicit, verified web,
identity, and sync path once GitHub-hosted runners are available, and resolves its selected branch
through `scripts/resolve-deployment-target.sh`. Unsupported refs fail before any
schema, build, or deploy step; there is no default environment. Production jobs
enter the GitHub `production` Environment, whose deployment-branch policy admits
only `main`.

Cloudflare Workers Builds owns automatic pull-request validation through the
dedicated `aquilla-web-preview` Worker. All six production/development Workers
remain disconnected from Git. The preview Worker has no custom domain or live
route, always targets development APIs, and never promotes a version or changes
production/development traffic. `versification-tool` remains disconnected
because it has no deployable Wrangler application.

The consolidated `.github/workflows/ci.yml` is `workflow_dispatch`-only. Normal
pull-request and push activity consumes no GitHub-hosted runner minutes. Cloudflare
receives GitHub repository events, runs the repository-owned build commands, and
reports its check results and preview links back to GitHub.

Every Workers Builds preview uses development API hosts, including builds of
`main`. Preview versions remain route-free permanently; they are never promoted
into a live Worker. Repository code converts slash-named branches into a stable,
lowercase, hashed preview alias before passing it to Wrangler.

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
3. Cloudflare Workers Builds settings, `.github/workflows/ci.yml`, and the
   dispatch-only `deploy-workers.yml`.
4. `config/cloudflare-deployments.json`, `cloudflare-version-deploy.mjs`, and
   `verify-worker-deployment.mjs`.
5. `scripts/resolve-deployment-target.sh` and `verify-deploy-branch.sh`.
6. GitHub branch protection Cloudflare check contexts and the `production`
   Environment branch policy (`main` only).
7. This matrix and the Workers Builds runbook.
8. `scripts/worker-deployment-contract.test.ts` and its targeted test command.
9. The live verifier for production and development before promotion.

Do not reset a Neon branch or clear an R2 bucket to repair a routing problem. First
identify the Worker version, named profile, Hyperdrive binding, and bucket binding,
then reconcile data before any destructive operation.
