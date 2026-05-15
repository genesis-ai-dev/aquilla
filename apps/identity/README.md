# @aquilla/identity

Identity service for codex-web / Aquilla. Per spec AD-5, this is the only worker that owns identity, organizations, project memberships, and the tokens that gate every other service. Relocated from top-level `auth-worker/` in Phase 3e (AD-11), renamed from `frontier-server` in the AD-11 spec-unification pass.

## Mount point

Mounted under `/api/identity/*` (see `routes.json` at the repo root) once the `aquilla.app` zone is provisioned in Cloudflare. Until then deploys land on the per-env `workers.dev` URLs:

| Env | Worker name | URL |
|---|---|---|
| production | `aquilla-prod-identity` | `https://aquilla-prod-identity.blue-darkness-7674.workers.dev` |
| staging | `aquilla-dev-identity` | `https://aquilla-dev-identity.blue-darkness-7674.workers.dev` |
| preview (per-PR) | `aquilla-pr-<N>-identity` | `https://aquilla-pr-<N>-identity.blue-darkness-7674.workers.dev` |

The frontend wires `VITE_AUTH_BASE` to the right URL at build time (see `.github/workflows/deploy.yml`).

## Surface

```
/api/v2/auth/register
/api/v2/auth/token
/api/v2/auth/me
/api/v2/auth/activity-log
/api/v2/auth/password-reset/{request,verify,reset}

/api/v2/sync-token                       — short-lived JWTs handed to sync-worker

/api/v2/users/lookup
/api/v2/users/search

/api/v2/orgs/me
/api/v2/orgs/:orgId/members
/api/v2/orgs/:orgId/members/:userId
/api/v2/orgs/:orgId/members/:userId/projects

/api/v2/projects                         — list / detail / settings / members
/api/v2/projects/:projectId/...          — incl. invites + source-linking
/api/v2/invites/...                      — multi-project invite flow

/api/v2/health                           — liveness for the frontend's AI gate

/api/v1/auth/*                           — legacy alias mounted on the same router
/__test__/reset                          — E2E only; gated by WRANGLER_LOCAL=1
```

## D1

Single database, owned here (sync-worker binds the same DB but does NOT declare `migrations_dir`):

| Env | Binding | Database |
|---|---|---|
| production | `AQUILLA_DB` | `aquilla-db` |
| staging | `AQUILLA_DB` | `aquilla-db-staging` |

Migrations under `migrations/` are wrangler-applied on every deploy.

## Secrets

Provisioned via `wrangler secret put` (never committed):

- `SECRET_KEY` — frontier JWT signing key (HS256). MUST match `aquilla-chat-worker`'s `SECRET_KEY` so a single Bearer token works against both.
- `SYNC_SECRET_KEY` — signs `/sync-token` JWTs AND authenticates admin calls to sync-worker. MUST match `aquilla-sync-worker`'s `SYNC_SECRET_KEY`.
- `RESEND_API_KEY` — outbound email for password-reset flow. Optional in dev.
- `GITLAB_ADMIN_TOKEN` — used during register/login for legacy GitLab user provisioning. Optional; without it `/register` returns 503 but `/token` still works for existing users.

See `.dev.vars.example` for local-dev values.

## Local development

```bash
cd apps/identity
npm install
cp .dev.vars.example .dev.vars   # then fill in your dev secrets
npm run dev                       # wrangler dev on :8787

npm run type-check                # tsc --noEmit
npm test                          # vitest run
```

E2E uses `scripts/e2e-up.ts` from the repo root, which boots this worker on `:8787` alongside `sync-worker` on `:8788`. See `e2e/README.md`.

## Deploy

```bash
npm run deploy                       # production
wrangler deploy --env=staging        # staging
```

CI handles both via `.github/workflows/deploy-workers.yml` (path filter on `apps/identity/**`). Per-PR previews are spun up by `.github/workflows/deploy-all-apps.yml` (under the `apps/*` umbrella), which substitutes `__PR__` into `wrangler.toml` before deploying with `--env preview`.
