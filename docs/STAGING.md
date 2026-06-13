# Staging environment (dev.aquilla.app)

Staging mirrors production so fixes can be validated on a real deploy before QA. It is the
`Ready for Review` → `Ready for QA` target in the `/issue` workflow (see `AGENTS.md`).

| Surface | Worker / resource | URL |
| --- | --- | --- |
| SPA | `aquilla-web-staging` | https://dev.aquilla.app |
| Identity + chat | `aquilla-dev-identity` | https://api.dev.aquilla.app/identity/*, `/chat/*` |
| Sync | `aquilla-sync-worker-staging` | https://api.dev.aquilla.app/sync/* |
| Data | Neon `staging` branch via Hyperdrive | project `sweet-paper-88472094`, branch `br-old-credit-aja5brf7` |
| Media | R2 `aquilla-snapshots-staging` | — |

Account: **Frontier R&D** (`6a80496d1e59948a9cbaa3c643ba81d7`). Staging has **no** dev auth
bypass (`WRANGLER_LOCAL`/`__dev__` routes are local-only) — sign in with a real account.

## Routine deploy

From repo root, with a Cloudflare token that has zone-route perms (same as prod deploys):

```bash
pnpm run deploy:aquilla:staging          # SPA + sync + auth
# or piecemeal:
pnpm run deploy:aquilla:staging:spa
pnpm run deploy:aquilla:staging:sync
pnpm run deploy:aquilla:staging:auth
```

The SPA script builds with `VITE_AUTH_BASE` / `VITE_SYNC_WORKER_HOST` / `VITE_CHAT_BASE`
pointed at `api.dev.aquilla.app`. (CI also deploys on push to the `dev` branch — see
`.github/workflows/deploy.yml` — but that path uses CI's non-zone token.)

## One-time provisioning (FRO-146)

Staging worker envs, the staging D1, R2, and DO namespace already exist in the
`wrangler.toml` files. The remaining steps move staging onto Neon (to match prod) and wire
the missing pieces. Run these once:

1. **Neon staging branch** — already created: `staging` (`br-old-credit-aja5brf7`), forked
   from prod. Grab its **pooled** connection string from the Neon console or MCP. Treat it
   as a secret; do not commit it.

2. **Create the staging Hyperdrive config** and paste its id into BOTH
   `auth-worker/wrangler.toml` and `sync-worker/wrangler.toml` (`[[env.staging.hyperdrive]]`,
   replacing `REPLACE_WITH_STAGING_HYPERDRIVE_ID`):

   ```bash
   wrangler hyperdrive create aquilla-staging \
     --connection-string="<neon staging pooled connection string>" \
     --caching-disabled
   ```

3. **Load the schema** onto the Neon staging branch if the fork didn't already carry it
   (the branch inherits prod data at fork time, so usually nothing to do):

   ```bash
   # only if needed:
   psql "<neon staging connection string>" -f db/postgres/schema.sql
   ```

4. **Set worker secrets** for both staging workers (same signing keys as prod so tokens
   interoperate during cross-env testing):

   ```bash
   cd auth-worker
   wrangler secret put SECRET_KEY        --env staging
   wrangler secret put SYNC_SECRET_KEY   --env staging
   wrangler secret put OPENROUTER_API_KEY --env staging
   cd ../sync-worker
   wrangler secret put SYNC_SECRET_KEY   --env staging
   ```

5. **DNS** — ensure `dev.aquilla.app` and `api.dev.aquilla.app` resolve on the `aquilla.app`
   zone (proxied CNAME/A records). The Workers Routes in the `[env.staging]` blocks attach
   on the first `--env=staging` deploy with a zone-perm token.

6. **Deploy** (`pnpm run deploy:aquilla:staging`) and **verify**:
   - `https://dev.aquilla.app` loads the SPA.
   - Sign in with a real account; create a project; confirm the write lands in the Neon
     `staging` branch (not prod) and `aquilla-snapshots-staging`.
   - Confirm the `__dev__` bypass routes 404 on staging.

When all six are done, FRO-146 is complete. The `/issue ... --deploy` flow then has a live
target.
