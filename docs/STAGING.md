# Staging environment

Staging mirrors production on isolated infrastructure so fixes can be validated
before QA. It is the `Ready for Review` -> `Ready for QA` target in the
`/issue` workflow.

| Surface | Worker / resource | URL |
| --- | --- | --- |
| SPA | `aquilla-web-staging` | https://staging.aquilla.app |
| Identity + chat | `aquilla-staging-identity` | https://api.staging.aquilla.app/identity/*, `/chat/*` |
| Sync | `aquilla-sync-worker-staging` | https://api.staging.aquilla.app/sync/* |
| Data | Neon `staging` branch via Hyperdrive | project `sweet-paper-88472094`, branch `staging` |
| Media | R2 `aquilla-snapshots-staging` | - |

Account: **Frontier R&D** (`6a80496d1e59948a9cbaa3c643ba81d7`). Staging has
no dev auth bypass (`WRANGLER_LOCAL` / `__dev__` routes are local-only), so sign
in with a real account.

## Routine deploy

From repo root, with a Cloudflare token that has zone-route permissions:

```bash
pnpm run deploy:aquilla:staging

# or piecemeal:
pnpm run deploy:aquilla:staging:spa
pnpm run deploy:aquilla:staging:sync
pnpm run deploy:aquilla:staging:auth
```

The staging SPA is built with `VITE_AUTH_BASE`, `VITE_SYNC_WORKER_HOST`, and
`VITE_CHAT_BASE` pointed at `api.staging.aquilla.app`. Worker deploys run a
target-aware Neon schema guard before publishing.

## Neon refresh model

Staging is a writable Neon child branch of `production`. Neon uses copy-on-write
storage, so the branch shares production pages and only accrues storage for
staging-specific deltas.

Reset staging from production manually:

```bash
pnpm neon:refresh:staging
```

GitHub Actions also runs the same command weekly on Sunday at 4:07 a.m.
America/New_York (`.github/workflows/staging-neon-refresh.yml`). The refresh
restores the `staging` branch from `production`, applies any pending repo
migrations, then checks the staging API health endpoint.

## Credentials and bindings

- CI needs `NEON_API_KEY` to resolve branch connection strings dynamically.
- Optional project-read health checks use `STAGING_API_PROJECT_READ_URL` and
  `STAGING_API_PROJECT_READ_TOKEN`.
- Static `NEON_STAGING_PG_*` secrets are supported as fallback for direct local
  migration checks, but should not be the primary CI path because branch
  endpoints can change during one-time branch replacement.
- Existing workers keep the Hyperdrive binding id
  `822231ade4da4db5b1955702e13d1ac3`; update the Hyperdrive origin connection
  string instead of changing `wrangler.toml`.

## Verification

After a reset or branch replacement:

```bash
pnpm neon:status:staging
curl https://api.staging.aquilla.app/identity/api/v2/health
```

Then load https://staging.aquilla.app, sign in with a real account, open a
project, and confirm writes land in the Neon `staging` branch and
`aquilla-snapshots-staging`, not production.
