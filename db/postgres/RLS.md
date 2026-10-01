# Row-Level Security backstop — Aquilla Postgres (AQU-289)

Migration: `db/postgres/migrations/0034_rls_backstop.sql`
(plus per-table additions in later migrations — see the table below)
Shim changes: `db/shim/postgres.ts` — `withUser()` / `asAdmin()`

---

## What is protected

**21 of the schema's 55 project-scoped tables have RLS enabled.** The list below is
generated from the migrations; `scripts/rls-coverage.test.ts` fails if this table and
the migrations disagree, and if any project-scoped table is neither covered nor
explicitly recorded as uncovered. Before that guard existed this section said "nine
tables" and listed `snapshots`, which migration 0039 dropped — for 60+ migrations,
while four OPSEC passes cited it as a live mitigation.

| Table | RLS policy name | Migration |
|---|---|---|
| `artifact_bindings` | `rls_artifact_bindings_project_access` | 0066 |
| `artifacts` | `rls_artifacts_project_access` | 0056 |
| `cell_attachments` | `rls_cell_attachments_project_access` | 0112 |
| `cell_audio` | `rls_cell_audio_project_access` | 0034 |
| `cell_audio_validators` | `rls_cell_audio_validators_project_access` | 0096 |
| `cell_validators` | `rls_cell_validators_project_access` | 0034 |
| `cells` | `rls_cells_project_access` | 0034 |
| `changesets` | `rls_changesets_project_access` | 0055 |
| `comments` | `rls_comments_project_access` | 0034 |
| `contextual_decisions` | `rls_contextual_decisions_select` / `_insert` / `_update` | 0076 |
| `contextual_drafts` | `rls_contextual_drafts_select` / `_insert` / `_update` | 0074 |
| `contextual_project_leases` | `rls_contextual_project_leases_select` / `_insert` / `_update` / `_delete` | 0074 |
| `contextual_run_events` | `rls_contextual_run_events_select` / `_insert` | 0074 |
| `contextual_runs` | `rls_contextual_runs_select` / `_insert` / `_update` | 0074 |
| `contextual_steering` | `rls_contextual_steering_select` / `_insert` / `_update` | 0074 |
| `events` | `rls_events_project_access` | 0034 |
| `file_section_progress` | `rls_file_section_progress_project_access` | 0053 |
| `files` | `rls_files_project_access` | 0034 |
| `plan_units` | `rls_plan_units_project_access` | 0089 |
| `project_settings` | `rls_project_settings_project_access` | 0034 |
| `scene_briefs` | `rls_scene_briefs_select` / `_insert` / `_update` | 0074 |
| `team_messages` | `rls_team_messages` | 0122 |
| `team_threads` | `rls_team_threads` | 0122 |

The 0034-family policies call `app_user_can_access_project(project_id)`, which checks all four membership paths (direct / group / org-at-Maintainer+ / creator) using `current_setting('app.user_id', true)`. AQU-1107 floors the org path at `org_members.role_level >= 600` so a Contributor org row is not a data-access grant. The 0074-family (contextual/autopilot) policies additionally require `project_id = current_setting('app.project_id', true)` — exact-project rather than any-accessible-project.

### What is NOT protected

Not covered *by design* — these are not project-scoped, and callers gate on user
identity at the route level: identity/org tables (`users`, `organizations`,
`org_members`, `groups`, `platform_settings`, `org_settings`, …).

Not covered, **not** by design — the other **34 project-scoped tables**. Each is
listed with a reason in `UNCOVERED` in `scripts/rls-coverage.test.ts`, which is the
authoritative ledger; adding a project-scoped table without a policy fails that test
until the decision is recorded. Two groups are worth naming here:

- **`project_members` and `group_project_grants` cannot take 0034's policy shape at
  all.** Reading them is *how* `app_user_can_access_project()` decides access, and the
  function is `SECURITY INVOKER`, so its own reads are subject to the caller's
  policies — a policy on either table that calls it recurses through itself. Covering
  them needs a self-scoped predicate, or a `SECURITY DEFINER` helper with a pinned
  `search_path`.
- **19 of the 34 were never granted to `app_runtime`** (`lanes`, `api_credentials`,
  `agent_memories`, `knowledge_docs`, `project_briefs`, `style_rules`, `concepts`,
  `cell_links`, `project_access_links`, …). That is not a small gap: those tables are
  on ordinary request paths, so a worker connected as `app_runtime` would fail
  `permission denied` on them. See § Deployment status — it is the main evidence that
  nothing connects as that role today, and therefore that adding policies is not yet
  worth doing.

Rows in `project_invites` and `project_access_links` are live credentials, so they are
the two highest-value entries in that ledger.

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
-- (repeat for the rest of the coverage table above; `snapshots` was dropped by 0039)

-- Re-enable when all call sites are confirmed correct:
ALTER TABLE cells            ENABLE ROW LEVEL SECURITY;
ALTER TABLE events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE files            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_validators  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_audio       ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;
-- (repeat for the rest of the coverage table above)
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

## Deployment status

**Unknown from this repository, and probably inert. Do not cite RLS as a live
mitigation without checking.** This section replaces a claim ("not applied to any
live Neon database — it exists only as a repo artifact") that was left unrevised
for ~90 migrations while review after review treated the backstop as enforced.

What the repo does establish:

- **The DDL has almost certainly been applied.** `db/postgres/migrations` is applied
  wholesale by `pnpm neon:apply`, and 0066/0074/0096/0112 contain unguarded
  `GRANT … TO app_runtime`, which errors if the role does not exist. So the role,
  the policies and `ENABLE`/`FORCE` are expected to be live.
- **But nothing can be connecting *as* `app_runtime`.** 19 project-scoped tables on
  ordinary request paths were never granted to it (§ What is NOT protected), so a
  worker using that role would fail `permission denied` on lane resolution, PAT
  lookup, agent memory and briefs. The app works, so the connection uses another
  role.
- **Any other role bypasses these policies**, because every policy in this schema is
  written `TO app_runtime`. `FORCE ROW LEVEL SECURITY` would otherwise make the
  owner visible-to-nothing rather than see-everything; since reads succeed, the
  connecting role must be `BYPASSRLS` (Neon's default owner is a member of
  `neon_superuser`, which is).

So the backstop is a coverage ledger, not a runtime control, until someone answers
one question out of band. Steps 2–6 of the Apply Procedure above are manual, in the
Neon and Cloudflare dashboards, and were never recorded anywhere in this repo.

**To resolve it, run against each live database and record the answer here:**

```sql
-- Which role does this connection use, and can it bypass RLS?
SELECT current_user, session_user,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls;

-- Does the runtime role exist, and can it log in?
SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime';

-- Is the policy set actually live? (pnpm neon:status reports this as drift too,
-- including the app_runtime grants since the 2026-09-28 contract fix.)
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity;
```

If the answer is "the connection is an owner/BYPASSRLS role" — the expected
outcome — then the options are, in order: finish the grants and cut over to
`app_runtime` per the Apply Procedure (with the soak), or stop treating RLS as a
layer and say so in `docs/OPSEC.md`. Either is fine; the current state, where it
is cited but unenforced, is not.

`SWARM-TODO(AQU-289): deploy-time — create runtime role on staging Neon branch,
apply migration, soak, then prod; verify admin console + migrations still work
via owner role.`
