# Recon: Phases C, E, I — Port-Ready Diff Matrix

> Generated: 2026-05-22 | Branch: `demo` HEAD `84867c8` vs `main` HEAD `1b2ac85`
> Read-only reconnaissance — no code modified.

---

## Phase C — AD-11 Rename Pass (`codex-* → aquilla-*`)

Reference commits: `813bb93` (AD-11 unification), `0544498` + `56b8a83` (R2 → `aquilla-snapshots`)

### C.1 — Worker name renames

| Worker | Demo `name` | Target `name` |
|--------|-------------|---------------|
| sync-worker (prod/bare) | `codex-sync-worker` | `aquilla-sync-worker` |
| sync-worker staging | `codex-sync-worker-staging` | `aquilla-sync-worker-staging` |
| auth-worker (prod) | `codex-auth-worker` | `aquilla-identity` |
| auth-worker staging | `codex-auth-worker-staging` | `aquilla-dev-identity` |
| chat-worker (prod) | `codex-chat-worker` | `aquilla-chat-worker` |
| chat-worker staging | `codex-chat-worker-staging` | `aquilla-chat-worker-staging` |

> Note: On main, `auth-worker/` is renamed `apps/identity/` and adds explicit `[env.production]` (`aquilla-prod-identity`) + `[env.preview]` (`aquilla-pr-__PR__-identity`) blocks. Demo should stay at `auth-worker/` path per the plan — rename only the wrangler `name` field.

### C.2 — D1 database binding renames

| Worker file (demo path) | Binding name | Demo DB name | Target DB name | Demo DB ID | Target DB ID |
|-------------------------|-------------|--------------|----------------|------------|--------------|
| `sync-worker/wrangler.toml` | `CODEX_DB` | `codex-db` | `aquilla-db` | `cf7133b2-227f-4f0a-9d8f-ad81ee05f27d` | `11828e9d-998b-4d3f-a405-91d9f624f94a` |
| `sync-worker/wrangler.toml` [env.staging] | `CODEX_DB` | `codex-db-staging` | `aquilla-db-staging` | `2afa2bb5-667a-4f0d-bc1e-fffa3c9f256f` | `c995bf9a-97c0-4966-a112-053a2d04d8f9` |
| `auth-worker/wrangler.toml` | `AUTH_DB` | `frontier-db-v2` | `aquilla-db` | `9c6abd81-01c3-44ce-9d93-9dfa1c7e1086` | `11828e9d-998b-4d3f-a405-91d9f624f94a` |
| `auth-worker/wrangler.toml` [env.staging] | `AUTH_DB` | `frontier-db-v2-staging` | `aquilla-db-staging` | `636fdec6-ba75-447f-b890-6743e00b95fe` | `c995bf9a-97c0-4966-a112-053a2d04d8f9` |
| `chat-worker/wrangler.toml` | `AUTH_DB` | `frontier-db-v2` | `frontier-db-v2` | `9c6abd81-01c3-44ce-9d93-9dfa1c7e1086` | unchanged (chat stays on frontier-db-v2 on main too) |
| `chat-worker/wrangler.toml` [env.staging] | `AUTH_DB` | `frontier-db-v2-staging` | `frontier-db-v2-staging` | `636fdec6-ba75-447f-b890-6743e00b95fe` | unchanged |

**Binding name to rename in `sync-worker/wrangler.toml`:** `CODEX_DB` → `AQUILLA_DB` (must also update every reference in `sync-worker/src/` TypeScript).

**Binding name in `auth-worker/wrangler.toml`:** `AUTH_DB` → `AQUILLA_DB` (matches main's `apps/identity/wrangler.toml`).

**Chat worker binding:** stays `AUTH_DB` on main — no rename needed here.

### C.3 — R2 bucket renames

| Worker file (demo path) | Binding | Demo bucket | Target bucket |
|-------------------------|---------|-------------|---------------|
| `sync-worker/wrangler.toml` | `SNAPSHOTS` | `codex-snapshots` | `aquilla-snapshots` |
| `sync-worker/wrangler.toml` [env.staging] | `SNAPSHOTS` | `codex-snapshots-staging` | `aquilla-snapshots-staging` |

The binding name `SNAPSHOTS` stays unchanged; only the physical `bucket_name` changes.

### C.4 — New Durable Object binding in `sync-worker/wrangler.toml`

Main adds a second DO class `ProjectSync` (per-project presence + event fanout) in `813bb93`. Demo only has `FileSync`. Required additions to `sync-worker/wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "ProjectSync"
class_name = "ProjectSync"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["ProjectSync"]
```

The legacy `FileSync` binding is retained on main (returns 410; DO migration continuity). Demo should keep it.

### C.5 — `wrangler.pr.toml.tpl` renames

`sync-worker/wrangler.pr.toml.tpl` needs these substitutions to match main's `apps/sync/wrangler.pr.toml.tpl` (commit `813bb93`):

| Field | Current demo value | Target value |
|-------|--------------------|--------------|
| `name` | `codex-sync-worker-pr-__PR__` | `aquilla-pr-__PR__-sync` |
| `bucket_name` | `codex-snapshots-staging` | `aquilla-snapshots-staging` |
| `database_name` | `codex-db-pr-__PR__` | `aquilla-pr-__PR__` |
| `binding` (D1) | `CODEX_DB` | `AQUILLA_DB` |

### C.6 — `auth-worker/wrangler.toml` new vars

Main's `apps/identity/wrangler.toml` adds these `[vars]` that demo lacks:

```toml
[vars]
ENV = "prod"
BASE_URL = "https://aquilla.app"           # was "https://codex-web.pages.dev"
SYNC_WORKER_URL = "https://aquilla-sync-worker.blue-darkness-7674.workers.dev"
```

`SYNC_WORKER_URL` is used by identity for fire-and-forget archive/R2 cleanup. Add it.

Also add explicit `[env.production]` and `[env.preview]` blocks per main (see `apps/identity/wrangler.toml`).

### C.7 — Routes declarations (new on main)

Main adds `routes = [...]` to both sync and identity workers so browsers hit them via `aquilla.app/api/sync/*` and `aquilla.app/api/identity/*` rather than `*.workers.dev`. Demo lacks all `routes` declarations.

| Worker (demo path) | Env | Route to add |
|--------------------|-----|--------------|
| `sync-worker/wrangler.toml` | `[env.staging]` | `"dev.aquilla.app/api/sync/*"` |
| `sync-worker/wrangler.toml` | `[env.production]` | `"aquilla.app/api/sync/*"` |
| `auth-worker/wrangler.toml` | top-level + `[env.production]` | `"aquilla.app/api/identity/*"` |
| `auth-worker/wrangler.toml` | `[env.staging]` | `"dev.aquilla.app/api/identity/*"` |
| `auth-worker/wrangler.toml` | `[env.preview]` | `"pr-__PR__.aquilla.app/api/identity/*"` |

### C.8 — Client-side URL / env var renames

**`src/lib/sync/partyserver-provider.ts` (line 12):**
```
PROD_HOST = "codex-sync-worker.blue-darkness-7674.workers.dev"
→ PROD_HOST = "aquilla.app/api/sync"
```
(mirrors the `apps/workspace/` change in commit `642e1ff`)

**`src/lib/sync/sync-token.ts` (line 5):**
Comment references `codex-auth-worker` — update comment to `aquilla-identity`. The env var `VITE_AUTH_BASE` name stays.

**`src/lib/completion/completion-service.ts` (lines 10-15):**
Comment references `codex-chat-worker` / `codex-chat-worker-staging` — update comment text only (these are comments, not runtime strings).

**`src/lib/sync/archive.ts` (line 45):**
Comment references `codex-db.files` — update comment to `aquilla-db.files`.

**`src/lib/sync/cloud-projects.ts` (line 31):**
Comment references `codex-db.files` — update comment to `aquilla-db.files`.

**`src/lib/sync/y-partyserver-spike.test.ts` (line 3):**
Comment references `codex-sync-worker` — update comment text.

**`src/lib/sync/sync-token.ts` (FRONTIER_DEFAULT):**
No code change needed here — the default `api.frontierrnd.com` is a runtime fallback that Phase D will remove entirely.

**`src/lib/sync/file-projection.ts` (line 2):**
Comment references `codex-db` — update comment to `aquilla-db`.

**CSS class (NOT a rename — keep as-is):**
`src/index.css` lines 120-124: `.codex-search-flash` and `@keyframes codex-search-flash` are UI class names, not resource identifiers. Do **not** rename.

**`src/branding/ThemeMode.tsx` (line 9):**
`STORAGE_KEY = "codex-theme"` — this is a localStorage key visible to users. Decide deliberately whether to rename (breaks existing user theme prefs) or leave. Main does not change this key. **Leave as-is for now.**

**`src/lib/sync/outbox.test.ts` (line 31) + `src/lib/sync/outbox-flush.test.ts` (line 66) + `src/lib/sync/cqrs-bridge.test.ts` (line 61):**
`"codex-cqrs-outbox"` — IndexedDB database name used in test cleanup. Main renames this to `"aquilla-cqrs-outbox"` in the outbox implementation. Check `src/lib/sync/outbox.ts` for the runtime DB name and rename both together.

**`src/hooks/useOutboxFlusher.ts` (line 86):**
`"codex-cqrs-outbox-flush"` — BroadcastChannel name. Rename to `"aquilla-cqrs-outbox-flush"`.

**`src/components/SnapshotsPage.tsx` (lines 75, 117):**
`.codex-snapshot.json` file extension — this is user-facing file naming. Main does not change it. **Leave as-is.**

### C.9 — TypeScript `Env` type in `sync-worker/src/`

The binding rename `CODEX_DB → AQUILLA_DB` must propagate through every `Env`-typed reference in `sync-worker/src/`. Files to update:

- `sync-worker/src/index.ts` — `Env` interface declaration
- Any file that reads `env.CODEX_DB` — use `rg 'CODEX_DB' sync-worker/src/` to enumerate.

---

## Phase E — D1 Schema Alignment to aquilla-specs

Reference commits: `43eea00`, `f10a4e8`, `f01b779`

### E.1 — Migration inventory

**Demo location:** `sync-worker/migrations/` — currently contains only `.gitkeep`. **All migrations are missing.**

**Main location:** `apps/identity/migrations/` (schema ownership lives in identity; sync-worker has a `.gitkeep` only on main too — `git ls-tree main:apps/sync/migrations/` returns just `.gitkeep`).

**Demo target path for migrations:** `auth-worker/migrations/` (since `auth-worker/` is the demo equivalent of `apps/identity/`). If `auth-worker/migrations/` does not exist yet, create it and add `migrations_dir = "migrations"` to `auth-worker/wrangler.toml`.

### E.2 — Complete migration file list (all missing from demo)

All 14 migration files must be ported from `main:apps/identity/migrations/` to `auth-worker/migrations/` (demo equivalent):

| # | Filename | What it does | Source on main |
|---|----------|-------------|----------------|
| 1 | `0001_initial.sql` | Full schema: users, activity_logs, password_reset_tokens, organizations, org_members, projects, project_members, project_invites, files, cells, cells_fts triggers, checkpoints, events, cell_validators | `main:apps/identity/migrations/0001_initial.sql` |
| 2 | `0002_events_ad2.sql` | Adds `parent_id UNIQUE` + `schema_version` to `events`; `cells.event_id` + `cells.source_event_id` (AD-2 parent-chain rule + AD-9 staleness pin) | `main:apps/identity/migrations/0002_events_ad2.sql` |
| 3 | `0003_cells_reshape.sql` | Destructive reshape of `cells`: adds `project_id`, `side` to PK; drops old PK; new composite PK `(project_id, file_id, cell_id, side)` | `main:apps/identity/migrations/0003_cells_reshape.sql` |
| 4 | `0004_projects_source_link.sql` | Adds `source_project_id` self-FK to `projects` (AD-9) | `main:apps/identity/migrations/0004_projects_source_link.sql` |
| 5 | `0005_project_settings.sql` | Adds `project_settings` table (per-project JSON blob: systemPrompt, rules, health/decay settings, validationCount, etc.) | `main:apps/identity/migrations/0005_project_settings.sql` |
| 6a | `0006_cells_side_primary_key.sql` | Rebuilds cells projection so source+target rows coexist per imported file/cell (pre-cursor to pair-lookup) | `main:apps/identity/migrations/0006_cells_side_primary_key.sql` |
| 6b | `0006_multi_project_invites.sql` | Loosens `project_invites.token` PK → `(token, project_id)` unique; allows one share-link token across N projects | `main:apps/identity/migrations/0006_multi_project_invites.sql` |
| 7 | `0007_ad12_groups.sql` | AD-12: `groups`, `group_members`, `group_project_grants` tables (org-scoped permission bundles, max-wins resolution) | `main:apps/identity/migrations/0007_ad12_groups.sql` |
| 8 | `0008_files_spec_metadata.sql` | Adds `role`, `kind`, `book_code`, `source_file_id`, `anchor_file_id`, `r2_key`, `import_format`, `parser_version` columns to `files` | `main:apps/identity/migrations/0008_files_spec_metadata.sql` |
| 9 | `0009_snapshots.sql` | Spec-aligned `snapshots` table (D1-only label/timestamp per AD-4; no R2 blob; separate from legacy `checkpoints`) | `main:apps/identity/migrations/0009_snapshots.sql` |
| 10 | `0010_users_spec_fields.sql` | Adds `display_name` and `avatar_url` to `users` | `main:apps/identity/migrations/0010_users_spec_fields.sql` |
| 11 | `0011_ad14_decay.sql` | Adds `cells.endorsement_count INTEGER DEFAULT 0` + `idx_cells_decay_drags`; migrates `project_settings.healthSettings → decaySettings` JSON key (AD-14) | `main:apps/identity/migrations/0011_ad14_decay.sql` |
| 12 | `0012_files_meta_event_id.sql` | **Phase E primary target.** Drop+recreate `files` (adds `event_id NOT NULL FK → events`, JSON `meta` column, drops `file_type`/`projected_from`). Drop+recreate `cell_validators` (drops `is_active`, renames `edit_event_id → event_id`, PK becomes `(project_id,file_id,cell_id,username)`) | `main:apps/identity/migrations/0012_files_meta_event_id.sql` |
| 13 | `0013_cells_pair_lookup.sql` | `CREATE INDEX idx_cells_pair_lookup ON cells(project_id, cell_id, side)` — required for AD-13 branching-search corpus join within D1's CPU limit | `main:apps/identity/migrations/0013_cells_pair_lookup.sql` |

### E.3 — Phase E specific items (commits `43eea00`, `f10a4e8`, `f01b779`)

#### `files.event_id` + JSON `meta` (migration `0012`, commit `f01b779`)

Migration `0012_files_meta_event_id.sql` is the primary schema work for Phase E. Key changes vs current `0001_initial.sql` `files` table:

- Adds `event_id TEXT NOT NULL REFERENCES events(id)` — chain head for AD-2
- Adds `meta TEXT NOT NULL DEFAULT '{}'` — sparse JSON for `r2_key`, `blob_sha`, `import_format`, `parser_version`, `source_language`, `target_language`
- Drops `file_type` column (derived as `kind ?? role ?? 'codex'` in read route)
- Drops `projected_from` column
- Adds `created_by TEXT`, `created_at INTEGER`, `updated_at INTEGER`
- New indexes: `idx_files_source_file`, `idx_files_anchor_file`, `idx_files_project_role`

#### `cell_validators` DELETE-on-unvalidate (migration `0012`, commit `f01b779`)

Old schema had `is_active INTEGER NOT NULL` — toggling validation flipped this flag. New contract:
- `is_active` column **dropped**
- Unvalidate = `DELETE FROM cell_validators WHERE ...` (no update)
- Validate = `INSERT OR REPLACE INTO cell_validators ...`
- `edit_event_id` renamed to `event_id`
- PK tightened to `(project_id, file_id, cell_id, username)`

The `DELETE` route for validators referenced in Phase E lives in `apps/sync/src/events/route.ts` on main. Port this HTTP `DELETE /api/v1/validators/:projectId/:fileId/:cellId` handler to `sync-worker/src/events/route.ts` on demo.

#### Role constants (no migration needed — code only)

Per `0001_initial.sql` comment (line 14–15): `roles` lookup table intentionally omitted. Constants live in:
- Client: `src/lib/frontier/roles.ts` (already present on demo per `src/lib/frontier/roles.test.ts`)
- Server: `apps/identity/src/services/project-permissions.ts` → port to `auth-worker/src/services/project-permissions.ts`

No D1 migration needed. Confirm demo has no `CREATE TABLE roles` in any migration file.

#### Seed fix (commit `f01b779`)

Main's `apps/identity/seed.sql` was rebuilt to post-reshape shape: `file.create` events written first, then `files`/`cells` projection rows that reference `event_id` (now NOT NULL FK). Demo likely lacks a seed file. Port `apps/identity/seed.sql` to `auth-worker/seed.sql`.

### E.4 — Code changes driven by migration `0012`

These are code files on main that handle the reshaped schema and must be ported to demo equivalents:

| Main file | Demo equivalent | Change |
|-----------|-----------------|--------|
| `apps/sync/src/events/event-projection.ts` | `sync-worker/src/events/event-projection.ts` | Use `event_id` as `files` chain head on projection writes; move `r2_key`/`import_format`/etc. into `meta` JSON |
| `apps/sync/src/events/handlers/file-create.ts` | `sync-worker/src/events/handlers/file-create.ts` | Extended `file.create` payload → populate `meta` + `event_id` |
| `apps/sync/src/events/route.ts` | `sync-worker/src/events/route.ts` | Add `DELETE /api/v1/validators/:projectId/:fileId/:cellId` |
| `apps/identity/src/__tests__/helpers/d1-fake.ts` | `auth-worker/src/__tests__/helpers/d1-fake.ts` | Updated fake-D1 for reshaped schema |
| `apps/sync/src/__tests__/helpers/d1-fake.ts` | `sync-worker/src/__tests__/helpers/d1-fake.ts` | Updated fake-D1 |

---

## Phase I — Hosting + Dev Stack

Reference commits: `2b5367f` / `642e1ff` (same commit, duplicate SHA in plan — Safari fix), `477e745` (dev-stack)

### I.1 — Mount `sync-worker` under `aquilla.app/api/sync`

**Current demo state:** `sync-worker/wrangler.toml` has no `routes` declarations. Worker is reachable only at `codex-sync-worker.blue-darkness-7674.workers.dev` (Safari-hostile).

**Target state** (from `2b5367f` / `642e1ff`):

#### Step 1 — `sync-worker/wrangler.toml` route declarations

Add to `[env.staging]`:
```toml
routes = ["dev.aquilla.app/api/sync/*"]
```

Add a new `[env.production]` block:
```toml
[env.production]
name = "aquilla-sync-worker"
account_id = "6a80496d1e59948a9cbaa3c643ba81d7"
routes = ["aquilla.app/api/sync/*"]
# ... mirror all [[env.production.*]] blocks from main:apps/sync/wrangler.toml
```

Note: CI strips `routes` lines before deploying (the CI token lacks zone-route perms). Routes are created out-of-band via CF dashboard or local `wrangler deploy`. Do **not** rely on CI to create them.

#### Step 2 — `sync-worker/src/index.ts` — add `stripApexPrefix`

Demo's `sync-worker/src/index.ts` has no prefix-stripping logic. Add this before the `export default { fetch }` handler (mirroring `main:apps/sync/src/index.ts` lines 93–116):

```typescript
const APEX_PREFIX = "/api/sync"

function stripApexPrefix(request: Request): Request {
  const url = new URL(request.url)
  if (url.pathname !== APEX_PREFIX && !url.pathname.startsWith(`${APEX_PREFIX}/`)) {
    return request
  }
  url.pathname = url.pathname.slice(APEX_PREFIX.length) || "/"
  return new Request(url.toString(), request)
}
```

Then in `fetch()`, call `request = stripApexPrefix(request)` as the first line before CORS handling.

This is conditional (no-op when there's no prefix) so local `wrangler dev` and direct `workers.dev` calls keep working.

#### Step 3 — Client `src/lib/sync/partyserver-provider.ts`

Update `PROD_HOST` (line 12):
```
"codex-sync-worker.blue-darkness-7674.workers.dev"
→ "aquilla.app/api/sync"
```

The existing `syncWorkerHttpOrigin()` and `buildProjectWsUrl()` helpers already handle a host that carries a path, so no further changes needed there.

#### Step 4 — `wrangler.pr.toml.tpl` route

The PR template does NOT get a `routes` declaration (per main — CI token lacks zone-route perms, PR-specific subdomains not DNS-configured yet). No change needed here beyond the name/bucket renames in Phase C.

### I.2 — `scripts/dev-stack.ts` — Local dev orchestrator

**Current demo state:** `scripts/dev-stack.ts` does **not exist**. Demo has only `scripts/lib/spawn-worker.ts`, which is already a partial port of main's helper (missing the `extraArgs` parameter added in `477e745`).

**What `scripts/dev-stack.ts` does on main (commit `477e745`):**

1. Boots `apps/identity` (`:8788`) via `spawnWranglerDev` with `--persist-to .wrangler-dev-state/`
2. Boots `apps/sync` (`:8789`) via `spawnWranglerDev` with same `--persist-to` so both Workers share one local sqlite
3. Optionally boots `apps/chat` (`:8790`) behind `--chat` flag
4. Applies identity migrations to local D1 (`wrangler d1 migrations apply aquilla-db --local --persist-to ...`) on every boot (idempotent)
5. Copies `.dev.vars.example → .dev.vars` for each worker if missing
6. Writes a managed `.env.development.local` pointing `VITE_AUTH_BASE` and `VITE_SYNC_WORKER_HOST` at the local ports
7. Starts Vite on `:5173` (via `npx vite`)
8. Tears everything down cleanly on Ctrl+C, deletes `.env.development.local`

**Demo path translation:**

| Main constant | Demo equivalent |
|---------------|-----------------|
| `REPO_ROOT/apps/identity` | `REPO_ROOT/auth-worker` |
| `REPO_ROOT/apps/sync` | `REPO_ROOT/sync-worker` |
| `REPO_ROOT/apps/chat` | `REPO_ROOT/chat-worker` |
| `REPO_ROOT/scripts/dev-stack.ts` | `REPO_ROOT/scripts/dev-stack.ts` (create new) |
| `REPO_ROOT/scripts/lib/spawn-worker.ts` | `REPO_ROOT/scripts/lib/spawn-worker.ts` (update) |

**`scripts/lib/spawn-worker.ts` gap:** Demo's version is missing the `extraArgs?: string[]` parameter added in `477e745`. The `--persist-to` flag is passed via `extraArgs` so both workers share local D1 state. The diff is:

```typescript
// ADD to opts type:
extraArgs?: string[]

// ADD to npx wrangler spawn args:
...(opts.extraArgs ?? []),
```

**`package.json` script change:**

Current demo `"dev": "vite"` must change to:
```json
"dev": "tsx scripts/dev-stack.ts",
"dev:vite": "vite"
```

(Keep `dev:vite` as the bare-Vite escape hatch for when workers aren't needed.)

**`wrangler d1 migrations apply` target database name:**

On main the command runs: `wrangler d1 migrations apply aquilla-db --local --persist-to ...` inside `IDENTITY_DIR` (`apps/identity`). On demo, run the same command inside `auth-worker/` pointing at the same DB name `aquilla-db` (once the auth-worker `wrangler.toml` D1 binding is renamed in Phase C and `migrations_dir = "migrations"` is added).

**`.wrangler-dev-state/` gitignore:**

Main adds `.wrangler-dev-state/` to `.gitignore` in `477e745`. Demo already has `.wrangler-dev-state/` in the untracked working tree (`git status` shows `?? .wrangler-dev-state/`) but it's not yet in `.gitignore`. Add it.

**Dev-only SPA routes (commit `477e745`):**

Main adds dev-only Dashboard + OnboardingWizard routes to `apps/workspace/src/App.tsx` gated on `import.meta.env.MODE !== "production"` so the SPA has somewhere to land when no front-door Worker is in front. Demo has `src/App.tsx`. Check if equivalent dev-only landing routes are needed — they are, since demo also has no front-door Worker.

### I.3 — Summary of new/changed files for Phase I

| File | Action | Notes |
|------|--------|-------|
| `sync-worker/src/index.ts` | Edit | Add `APEX_PREFIX` + `stripApexPrefix()` function; call it first in `fetch()` |
| `sync-worker/wrangler.toml` | Edit | Add `[env.staging].routes` + new `[env.production]` block |
| `src/lib/sync/partyserver-provider.ts` | Edit | `PROD_HOST` → `"aquilla.app/api/sync"` |
| `scripts/lib/spawn-worker.ts` | Edit | Add `extraArgs?: string[]` parameter |
| `scripts/dev-stack.ts` | Create | Port from `main:scripts/dev-stack.ts` with path substitutions above |
| `package.json` | Edit | `"dev": "tsx scripts/dev-stack.ts"`, add `"dev:vite": "vite"` |
| `.gitignore` | Edit | Add `.wrangler-dev-state/` and `.dev-stack-logs/` |
| `auth-worker/wrangler.toml` | Edit | Add `migrations_dir = "migrations"` |
| `auth-worker/migrations/` | Create dir + files | All 14 migration files from `main:apps/identity/migrations/` |

---

## Cross-phase dependencies

```
Phase C (renames) ──────────────────────────────────────────────┐
Phase E (schema)  ──────────────────────────────────────────────┤─→ both can run after Phase B (Yjs rip) lands
Phase I (hosting) ──────────────────────────────────────────────┘
```

Phase I's `dev-stack.ts` depends on Phase C (correct DB names in wrangler.toml) and Phase E (migrations exist at `auth-worker/migrations/`) to be useful, but can be written independently.

Phase E migration `0012` (`files.event_id NOT NULL`) requires the events table to exist (`0001`) and the events-write path from Phase A to be working before any real data can be projected.
