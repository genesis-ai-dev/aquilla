# Row-Level Security backstop — Aquilla Postgres (AQU-289)

Migration: `db/postgres/migrations/0034_rls_backstop.sql`
Shim changes: `db/shim/postgres.ts` — `withUser()` / `asAdmin()`

---

## What is protected

Eight project-scoped tables have RLS enabled:

| Table | RLS policy name |
|---|---|
| `cells` | `rls_cells_project_access` |
| `events` | `rls_events_project_access` |
| `files` | `rls_files_project_access` |
| `comments` | `rls_comments_project_access` |
| `cell_validators` | `rls_cell_validators_project_access` |
| `cell_audio` | `rls_cell_audio_project_access` |
| `project_settings` | `rls_project_settings_project_access` |
| `snapshots` | `rls_snapshots_project_access` |

Every policy calls `app_user_can_access_project(project_id)`, which checks all four membership paths (direct / group / org / creator) using `current_setting('app.user_id', true)`.

Tables NOT covered by RLS (intentional):
- Identity/org tables (`users`, `organizations`, `org_members`, `groups`, …) — they are not project-scoped; callers already gate on user identity at the route level.
- Cross-project tables (`assignments`, `cell_waivers`, `cell_backtranslations`, etc.) — they carry a `project_id` column but are accessed only from routes that have already verified project membership; adding RLS here is a follow-on task.

---

## Runtime role

Workers must connect as `app_runtime`, not as the table-owner role.

- **Owner role**: used for migrations / psql admin.  Bypasses RLS automatically (Postgres default).  Must NOT be used in production Hyperdrive bindings.
- **app_runtime**: `NOINHERIT NOLOGIN` base; enable LOGIN + set a strong password on the Neon dashboard (or via the owner connection): `ALTER ROLE app_runtime WITH LOGIN PASSWORD '<strong>';`

---

## Apply procedure (staging → prod)

1. Connect as the owner role:
   ```
   psql $NEON_OWNER_CONNECTION_STRING -f db/postgres/migrations/0034_rls_backstop.sql
   ```
2. Enable login on `app_runtime` (Neon dashboard → Roles, or via owner psql):
   ```sql
   ALTER ROLE app_runtime WITH LOGIN PASSWORD '<strong-random-password>';
   ```
3. Build a Neon connection string for `app_runtime` (same database, different role).
4. Create a second Hyperdrive configuration in the Cloudflare dashboard pointing to the `app_runtime` connection string.
5. Update both workers' `HYPERDRIVE` bindings (in `wrangler.toml` or the Cloudflare dashboard) to use the new `app_runtime` Hyperdrive.
6. **Soak on staging for ≥ 24 hours** before promoting to production.  A missed `SET LOCAL` returns 0 rows silently — watch for unexpectedly empty API responses, not 500 errors.
7. Deploy to production.

### wrangler.toml notes (both workers)

```toml
# Replace the existing HYPERDRIVE binding with the app_runtime one.
# Keep the owner binding under a DIFFERENT name (e.g. HYPERDRIVE_ADMIN)
# if you need it for migration scripts — but never expose it to routes.
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<app_runtime-hyperdrive-id>"

# Optional: separate admin binding for migration tooling only.
# [[hyperdrive]]
# binding = "HYPERDRIVE_ADMIN"
# id = "<owner-hyperdrive-id>"
```

---

## Instant per-table rollback

If a missed `SET LOCAL` causes silent 0-row bugs in production, disable RLS per table without dropping the policy (policies survive and are immediately re-enabled):

```sql
-- Disable (instant, no lock required):
ALTER TABLE cells            DISABLE ROW LEVEL SECURITY;
ALTER TABLE events           DISABLE ROW LEVEL SECURITY;
ALTER TABLE files            DISABLE ROW LEVEL SECURITY;
ALTER TABLE comments         DISABLE ROW LEVEL SECURITY;
ALTER TABLE cell_validators  DISABLE ROW LEVEL SECURITY;
ALTER TABLE cell_audio       DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots        DISABLE ROW LEVEL SECURITY;

-- Re-enable when all call sites are confirmed correct:
ALTER TABLE cells            ENABLE ROW LEVEL SECURITY;
ALTER TABLE events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE files            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_validators  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_audio       ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots        ENABLE ROW LEVEL SECURITY;
```

---

## Shim usage

### Authenticated requests

At the request boundary, after JWT verification:

```ts
const db = env.AQUILLA_PG.withUser(user.id)
// All subsequent prepare().bind().run() calls on `db` are within a
// transaction that has SET LOCAL app.user_id = '<user.id>'.
const rows = await db.prepare("SELECT * FROM cells WHERE project_id = ?").bind(projectId).all()
```

### Identity-less paths (asAdmin)

Routes authenticated by non-user mechanisms (SYNC_SECRET_KEY, shared secret, platform-admin gate) must call `asAdmin()`:

```ts
const db = env.AQUILLA_PG.asAdmin()
// Runs with SET LOCAL app.user_id = '' — bypasses RLS.
await db.prepare("SELECT * FROM events WHERE project_id = ?").bind(projectId).all()
```

### Named asAdmin() call sites (AQU-289 audit)

| Worker | File / route | Auth mechanism |
|---|---|---|
| sync-worker | `events/rebuild.ts` POST `/admin/projects/:id/rebuild-projection` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/rebuild-fts.ts` POST `/admin/projects/:id/rebuild-fts` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-ingest-route.ts` POST `/migrate/ingest` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-settings-route.ts` POST `/migrate/settings` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-project-route.ts` POST `/migrate/project` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-finalize-route.ts` POST `/migrate/finalize` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-event-ids-route.ts` POST `/migrate/event-ids` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/migrate-audio-route.ts` POST `/migrate/audio` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/import-route.ts` POST `/import` (bulk USFM) | `SYNC_SECRET_KEY` bearer |
| sync-worker | `events/import-morph-route.ts` POST `/import-morph` | `SYNC_SECRET_KEY` bearer |
| sync-worker | `diarization.ts` POST `/api/v1/diarization/callback` | `DIARIZATION_SHARED_SECRET` header |
| sync-worker | `admin.ts` DELETE/GET `/admin/files/:pid/:fid` | `SYNC_SECRET_KEY` bearer |
| auth-worker | `routes/admin.ts` GET `/api/v2/admin/*` | `PLATFORM_ADMINS` gate + authMiddleware |

Note: the `diarization.ts` `/start` and `/status` routes use sync-token auth (user-scoped) — those are `withUser()` paths, not `asAdmin()`.

---

## Staging soak warning

A missed `SET LOCAL` returns **0 rows silently**, not an error.  This is the
expected fail-closed behaviour for the RLS backstop, but it can look like a
regression in features that return empty lists.  During staging soak:

- Monitor for API responses returning unexpectedly empty arrays.
- Check worker logs for `SET LOCAL` calls — each transaction should log the user_id if you add debug logging.
- Run the test suite from `auth-worker/` and `sync-worker/` — the shim tests cover the guard behaviour.
- Verify the admin console routes (which use `asAdmin()`) still return cross-tenant data.

---

## NOT applied to live Neon

This migration has **not** been applied to any live Neon database.  It exists
only as a repo artifact.  See the Apply Procedure above.

`SWARM-TODO(AQU-289): deploy-time — create runtime role on staging Neon branch,
apply migration, soak, then prod; verify admin console + migrations still work
via owner role.`
