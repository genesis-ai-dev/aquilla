# Recon: Phase A + B Diff Matrix

> Generated 2026-05-22 by recon subagent. Read-only. Do NOT modify code.
>
> **Branch context:**
> - `demo` HEAD `84867c8` — single-app layout (`src/`, `sync-worker/`, `auth-worker/`, `chat-worker/`)
> - `main` HEAD `1b2ac85` — monorepo (`apps/identity/`, `apps/sync/`, `apps/workspace/`)
> - `dev3` — intermediate branch that has Phase A–B work in demo-compatible layout (single-app). PRs `#79–#82` and `#91` landed here, not on `main`. Use dev3 as the **primary porting reference** for path-compatible code; use `main` for the final settled version.
>
> **Path translation:** `apps/sync/src/…` ↔ `sync-worker/src/…`, `apps/workspace/src/…` ↔ `src/…`, `apps/identity/migrations/…` ↔ `auth-worker/migrations/…`

---

## Section 1 — Schema Diff (Phase A.1)

### 1.1 Migration files: demo vs reference branches

Demo has **zero `.sql` migration files**. `sync-worker/wrangler.toml` binds `CODEX_DB` (old name). `auth-worker/wrangler.toml` binds `AUTH_DB → frontier-db-v2` (legacy external schema).

Main keeps migrations in `apps/identity/migrations/` (0001–0013). Dev3's equivalent is `apps/frontier-server/migrations/` (0001–0006).

**All migrations below must be created at `auth-worker/migrations/` on demo** (Phase C renames binding from `frontier-db-v2` to `aquilla-db`, but Phase A just needs the SQL files in place).

### 1.2 Tables/columns demo is missing

#### `events` table

Demo's `events` table (established in `apps/identity/migrations/0001_initial.sql` on main) has these columns:
```
id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts
```

Missing on demo vs `0002_events_ad2.sql` (main `apps/identity/migrations/0002_events_ad2.sql` / dev3 `apps/frontier-server/migrations/0002_events_ad2.sql`):

| Column | Type | Migration | Purpose |
|---|---|---|---|
| `parent_id` | TEXT (nullable) | `0002_events_ad2.sql` | AD-2 prior winning event on cell chain |
| `server_seq` | INTEGER NOT NULL DEFAULT 0 | `0002_events_ad2.sql` | Per-project monotonic sequence; canonical ordering key |

Missing indexes:
| Index | SQL | Migration |
|---|---|---|
| `idx_events_project_seq` | `UNIQUE(project_id, server_seq)` | `0002_events_ad2.sql` |
| `idx_events_parent_lookup` | `(project_id, file_id, cell_id, parent_id)` | `0002_events_ad2.sql` |

**Porting note:** Demo's `event-projection.ts` uses `PersistedEvent` without `parentId` / `serverSeq`. Main's version (`apps/sync/src/events/event-projection.ts`) carries both fields and runs an AD-2 winning-child guard before applying projection. The entire `event-projection.ts` needs replacement, not just the schema.

#### `cells` table

Demo's `cells` table PK: `(file_id, cell_id)` with columns `content_text, content_hash, validated, word_count, last_editor, last_edit_at, projected_from, edit_count`.

Migration `0003_cells_reshape.sql` (main / dev3) drops and recreates with the AD-2/AD-9 shape:

| Column | Present on demo | Notes |
|---|---|---|
| `project_id` | NO | Required for PK |
| `file_id` | YES (old PK part) | |
| `cell_id` | YES (old PK part) | |
| `side` | NO | `'source' | 'target'` CHECK constraint |
| `value` | NO (was `content_text`) | Renamed |
| `value_html` | NO | New |
| `type` | NO | `'verse' | 'header' | 'footnote'` |
| `canonical_ref` | NO | e.g. `'GEN 1:1'` |
| `anchor_cell_id` | NO | Chain ordering |
| `event_id` | NO | AD-2 chain head; FK → `events.id` |
| `source_event_id` | NO | AD-9 staleness pin; FK → `events.id` |
| `last_editor` | YES | Unchanged |
| `last_edit_at` | YES | Unchanged |
| `validated` | YES | Unchanged |
| `word_count` | YES | Unchanged |
| `content_hash` | YES | Unchanged (djb2) |
| `edit_count` | YES (on demo) | **REMOVED** on main (not present in 0003) |
| `projected_from` | YES (on demo) | **REMOVED** on main |

**PK divergence:** dev3's `0003` uses `PRIMARY KEY (project_id, file_id, cell_id)` (no `side`); main's `0006_cells_side_primary_key.sql` later adds `side` to make it `(project_id, file_id, cell_id, side)`. Target the main shape.

New indexes added by `0003`:
- `idx_cells_file_order ON cells(project_id, file_id, anchor_cell_id)`
- `idx_cells_source_basis ON cells(source_event_id)`
- `idx_cells_validated ON cells(project_id, file_id, validated)`
- `idx_cells_last_edit ON cells(project_id, file_id, last_edit_at)`

#### `files` table

Migration `0012_files_meta_event_id.sql` (main) drops and recreates `files` with `event_id`:

| Column | Present on demo | Notes |
|---|---|---|
| `id` | YES | Unchanged |
| `project_id` | YES | Unchanged |
| `name` | YES | Unchanged |
| `role` | NO (was `file_type`) | `'source' | 'target' | 'dictionary' | 'translationNotes'` |
| `kind` | NO | `'codex' | 'usfm' | 'docx' | 'vtt' | …` |
| `book_code` | NO | e.g. `'GEN'` |
| `source_file_id` | NO | AD-9 pairing |
| `anchor_file_id` | NO | File ordering |
| `event_id` | NO | **AD-2 chain head** FK → `events.id` |
| `cell_count` | YES | Unchanged |
| `approved_count` | YES | Unchanged |
| `word_count` | YES | Unchanged |
| `last_edit_at` | YES | Unchanged |
| `meta` | NO | JSON sparse column |
| `created_by` | NO | New |
| `created_at` | NO | New |
| `updated_at` | YES | Unchanged |
| `file_type` | YES (on demo) | **REMOVED** (collapsed into `role` + `kind`) |
| `source_language` | YES (on demo) | **REMOVED** (moved to `meta`) |
| `target_language` | YES (on demo) | **REMOVED** (moved to `meta`) |
| `projected_from` | YES (on demo) | **REMOVED** |

#### `cell_validators` table

Migration `0012_files_meta_event_id.sql` also reshapes `cell_validators`:

| Column | Present on demo | Notes |
|---|---|---|
| `project_id` | YES | Unchanged |
| `file_id` | YES | Unchanged |
| `cell_id` | YES | Unchanged |
| `event_id` | NO (was `edit_event_id`) | Renamed |
| `username` | YES | Unchanged |
| `decided_ts` | YES | Unchanged |
| `is_active` | YES (on demo) | **REMOVED** (DELETE-on-unvalidate pattern) |
| `edit_event_id` | YES (on demo) | **REMOVED** (renamed to `event_id`) |

New PK: `(project_id, file_id, cell_id, username)` (removes `edit_event_id` from PK).

### 1.3 Full migration sequence for demo

Create `auth-worker/migrations/` with these files ported from `apps/identity/migrations/` (main):

| File | Source on main | Content |
|---|---|---|
| `0001_initial.sql` | `apps/identity/migrations/0001_initial.sql` | Full schema including events, cells, files, cell_validators |
| `0002_events_ad2.sql` | `apps/identity/migrations/0002_events_ad2.sql` | parent_id + server_seq on events |
| `0003_cells_reshape.sql` | `apps/identity/migrations/0003_cells_reshape.sql` | New cells shape with side, value, event_id, source_event_id |
| `0004_projects_source_link.sql` | `apps/identity/migrations/0004_projects_source_link.sql` | projects.source_project_id |
| `0005_project_settings.sql` | `apps/identity/migrations/0005_project_settings.sql` | project_settings table |
| `0006_cells_side_primary_key.sql` | `apps/identity/migrations/0006_cells_side_primary_key.sql` | Add side to cells PK |
| `0006_multi_project_invites.sql` | `apps/identity/migrations/0006_multi_project_invites.sql` | Invite groups |
| `0007_ad12_groups.sql` | `apps/identity/migrations/0007_ad12_groups.sql` | Groups |
| `0008_files_spec_metadata.sql` | `apps/identity/migrations/0008_files_spec_metadata.sql` | files spec metadata |
| `0009_snapshots.sql` | `apps/identity/migrations/0009_snapshots.sql` | Snapshots table |
| `0010_users_spec_fields.sql` | `apps/identity/migrations/0010_users_spec_fields.sql` | User spec fields |
| `0011_ad14_decay.sql` | `apps/identity/migrations/0011_ad14_decay.sql` | Decay health |
| `0012_files_meta_event_id.sql` | `apps/identity/migrations/0012_files_meta_event_id.sql` | files.event_id + cell_validators reshape |
| `0013_cells_pair_lookup.sql` | `apps/identity/migrations/0013_cells_pair_lookup.sql` | idx_cells_pair_lookup |

**Wrangler binding change (Phase C, but needed by A):** `AUTH_DB` / `CODEX_DB` → `AQUILLA_DB`. All read routes on main use `env.AQUILLA_DB`; demo uses `env.CODEX_DB`.

---

## Section 2 — Read-Route Diff (Phase A.2)

Reference: `apps/sync/src/events/` (main) vs `sync-worker/src/events/` (demo).

| Route file | Main path | Demo path | Status |
|---|---|---|---|
| Events audit log | `apps/sync/src/events/read-route.ts` | `sync-worker/src/events/read-route.ts` | **PRESENT-BUT-STALE** — binding name `CODEX_DB` vs `AQUILLA_DB`; orderby uses `server_ts`; missing `server_seq`/`parent_id` columns in response |
| Validators read | `apps/sync/src/events/validators-read-route.ts` | `sync-worker/src/events/validators-read-route.ts` | **PRESENT-BUT-STALE** — `CODEX_DB` vs `AQUILLA_DB`; uses `is_active` (removed on main); `edit_event_id` → `event_id` rename |
| Cells audit stats | `apps/sync/src/events/cells-audit-read-route.ts` | `sync-worker/src/events/cells-audit-read-route.ts` | **PRESENT-BUT-STALE** — `CODEX_DB` vs `AQUILLA_DB`; old columns (`edit_count`, `projected_from`-based `last_edit_event_id`); missing `side`, `source_event_id`; validator join uses `is_active` |
| **Cells read** | `apps/sync/src/events/cells-read-route.ts` | **MISSING** | **MISSING** — port from `dev3` (`cc02ca7`:not in dev3 either) or `main:apps/sync/src/events/cells-read-route.ts` → `sync-worker/src/events/cells-read-route.ts` |
| **Files read** | `apps/sync/src/events/files-read-route.ts` | **MISSING** | **MISSING** — port from `dev3:sync-worker/src/events/files-read-route.ts` or main |
| **Cell history read** | `apps/sync/src/events/cell-history-read-route.ts` | **MISSING** | **MISSING** — port from `dev3:sync-worker/src/events/cell-history-read-route.ts` |
| **Search route** | `apps/sync/src/events/search-route.ts` | **MISSING** | **MISSING** — port from `dev3:sync-worker/src/events/search-route.ts` (Phase F) |
| **Stale source route** | `apps/sync/src/events/stale-source-route.ts` | **MISSING** | **MISSING** — port from `dev3:sync-worker/src/events/stale-source-route.ts` (Phase E) |
| **Import route** | `apps/sync/src/events/import-route.ts` | **MISSING** | **MISSING** — main-only, no dev3 equivalent; port from `main:apps/sync/src/events/import-route.ts` → `sync-worker/src/events/import-route.ts` (Phase H) |
| **Branching search** | `apps/sync/src/events/branching-search-route.ts` | **MISSING** | **MISSING** — port from main (Phase F) |
| **Branching search passages** | `apps/sync/src/events/branching-search-passages-route.ts` | **MISSING** | **MISSING** — port from main (Phase F) |
| **File meta** | `apps/sync/src/events/file-meta.ts` | **MISSING** | **MISSING** — helper used by files-read-route; port from main |
| Event projection | `apps/sync/src/events/event-projection.ts` | `sync-worker/src/events/event-projection.ts` | **PRESENT-BUT-STALE** — old `PersistedEvent` interface (no `parentId`/`serverSeq`); old cells schema (file_id/cell_id, not project_id/file_id/cell_id/side); no AD-2 first-child guard; old `cell_validators` with `is_active`/`edit_event_id` |
| Types | `apps/sync/src/events/types.ts` | `sync-worker/src/events/types.ts` | **PRESENT-BUT-STALE** — major divergence in `EventKind` (demo: flat `cell.commit/validate/unvalidate/thread.add/thread.resolve/cell.metadata.set/file.create`; main: prefixed `source.cell.{create,commit,delete,reorder}`, `target.cell.*`, `cell.validate/unvalidate/endorsement/endorsement.revoke`, `file.create`, `project.link-source`) |
| Dispatch | `apps/sync/src/events/dispatch.ts` | `sync-worker/src/events/dispatch.ts` | **PRESENT-BUT-STALE** — routes to old handlers (`cell-commit.ts`, `cell-validate.ts`, `cell-unvalidate.ts`, `events-audit-only.ts`); main uses new `handleCellEvent` for all cell kinds |
| Role policy | `apps/sync/src/events/role-policy.ts` | `sync-worker/src/events/role-policy.ts` | **PRESENT-BUT-STALE** — old kind names; main has `source.*` → PROJECT_LEAD, `target.*` → CONTRIBUTOR |
| Rebuild | `apps/sync/src/events/rebuild.ts` | `sync-worker/src/events/rebuild.ts` | likely stale (references old projection) |
| Authorize | `apps/sync/src/events/authorize.ts` | `sync-worker/src/events/authorize.ts` | likely current — check diff |
| Broadcast | `apps/sync/src/events/broadcast.ts` | `sync-worker/src/events/broadcast.ts` | likely current |
| Coalescer | `apps/sync/src/events/coalescer.ts` | `sync-worker/src/events/coalescer.ts` | **PRESENT-AND-CURRENT** (diff returns empty) |
| Realtime protocol | `apps/sync/src/events/realtime.ts` | `sync-worker/src/events/realtime.ts` | **PRESENT-BUT-STALE** — missing `by?: string` field on `event` message type (minor) |

### Handler files

| File | Main path | Demo path | Status |
|---|---|---|---|
| Cell events (unified) | `apps/sync/src/events/handlers/cell-events.ts` | **MISSING** | **MISSING** — replaces demo's split `cell-commit.ts`, `cell-validate.ts`, `cell-unvalidate.ts` |
| File create handler | `apps/sync/src/events/handlers/file-create.ts` | `sync-worker/src/events/handlers/file-create.ts` | likely stale |
| Handler types | `apps/sync/src/events/handlers/types.ts` | **MISSING** | **MISSING** (demo has `handlers/` but no `types.ts`) |
| `cell-commit.ts` | **DELETED on main** | `sync-worker/src/events/handlers/cell-commit.ts` | demo-only — delete |
| `cell-validate.ts` | **DELETED on main** | `sync-worker/src/events/handlers/cell-validate.ts` | demo-only — delete |
| `cell-unvalidate.ts` | **DELETED on main** | `sync-worker/src/events/handlers/cell-unvalidate.ts` | demo-only — delete |
| `events-audit-only.ts` | **DELETED on main** | `sync-worker/src/events/handlers/events-audit-only.ts` | demo-only — delete |

### DO / project-level sync-worker files

| File | Main path | Demo path | Status |
|---|---|---|---|
| `project-do.ts` | `apps/sync/src/project-do.ts` | **MISSING** | **MISSING** — AD-1 per-project DO (presence, focus-lock, broadcast relay). Port from `dev3:sync-worker/src/project-do.ts` (demo layout available at commit `cc02ca7`) |
| `project-do-handlers.ts` | `apps/sync/src/project-do-handlers.ts` | **MISSING** | **MISSING** — pure functions for DO state transitions. Port from `dev3:sync-worker/src/project-do-handlers.ts` |
| `project-do-types.ts` | `apps/sync/src/project-do-types.ts` | **MISSING** | **MISSING** — Port from `dev3:sync-worker/src/project-do-types.ts` |
| `voice-convert.ts` | `apps/sync/src/voice-convert.ts` | **MISSING** | **MISSING** — Phase J; port from main |
| `projection.ts` | **DELETED on main** | `sync-worker/src/projection.ts` | demo-only (Yjs-based) — **delete** |
| `incremental.ts` | **DELETED on main** | `sync-worker/src/incremental.ts` | demo-only (Yjs-based) — **delete** |
| `index.ts` | `apps/sync/src/index.ts` | `sync-worker/src/index.ts` | **PRESENT-BUT-STALE** — demo uses `YServer`/partyserver/FileSync DO; main uses `ProjectSync` DO; demo missing `ProjectSync` export; all routes wired differently |

---

## Section 3 — Client Read-Fetcher Diff (Phase A.2 / Phase B)

Reference: `apps/workspace/src/lib/sync/` (main) vs `src/lib/sync/` (demo).

| File | Main path | Demo path | Status |
|---|---|---|---|
| `cells-read.ts` | `apps/workspace/src/lib/sync/cells-read.ts` | **MISSING** | **MISSING** — port from `dev3:src/lib/sync/cells-read.ts` (`63d2ba4`) |
| `cells-read-types.ts` | `apps/workspace/src/lib/sync/cells-read-types.ts` | **MISSING** | **MISSING** — port from `dev3:src/lib/sync/cells-read-types.ts` |
| `history-read.ts` | `apps/workspace/src/lib/sync/history-read.ts` | **MISSING** | **MISSING** — port from `dev3:src/lib/sync/history-read.ts` (`5baa91d`) |
| `history-read-types.ts` | `apps/workspace/src/lib/sync/history-read-types.ts` | **MISSING** | **MISSING** |
| `members-read.ts` | `apps/workspace/src/lib/sync/members-read.ts` | **MISSING** | **MISSING** — port from `dev3:src/lib/sync/members-read.ts` |
| `members-read-types.ts` | same | **MISSING** | **MISSING** |
| `orgs-read.ts` | `apps/workspace/src/lib/sync/orgs-read.ts` | **MISSING** | **MISSING** |
| `orgs-read-types.ts` | same | **MISSING** | **MISSING** |
| `projects-read.ts` | `apps/workspace/src/lib/sync/projects-read.ts` | **MISSING** | **MISSING** |
| `projects-read-types.ts` | same | **MISSING** | **MISSING** |
| `search-read.ts` | `apps/workspace/src/lib/sync/search-read.ts` | **MISSING** | **MISSING** (Phase F) |
| `search-read-types.ts` | same | **MISSING** | **MISSING** |
| `settings-read.ts` | `apps/workspace/src/lib/sync/settings-read.ts` | **MISSING** | **MISSING** |
| `settings-read-types.ts` | same | **MISSING** | **MISSING** |
| `stale-source-read.ts` | `apps/workspace/src/lib/sync/stale-source-read.ts` | **MISSING** | **MISSING** (Phase E) |
| `stale-source-read-types.ts` | same | **MISSING** | **MISSING** |
| `source-linking-read.ts` | `apps/workspace/src/lib/sync/source-linking-read.ts` | **MISSING** | **MISSING** |
| `source-linking-read-types.ts` | same | **MISSING** | **MISSING** |
| `bulk-import.ts` | `apps/workspace/src/lib/sync/bulk-import.ts` | **MISSING** | **MISSING** (Phase H) |
| `events-emit.ts` | `apps/workspace/src/lib/sync/events-emit.ts` | **MISSING** | **MISSING** — primary event write helper. Port from `dev3:src/lib/sync/events-emit.ts` (`cc02ca7`) |
| `outbox-types.ts` | `apps/workspace/src/lib/sync/outbox-types.ts` | **MISSING** | **MISSING** — typed mirror of AD-2 event grammar. Port from `dev3:src/lib/sync/outbox-types.ts` (`cc02ca7`) |
| `ws-reconciler.ts` | `apps/workspace/src/lib/sync/ws-reconciler.ts` | **MISSING** | **MISSING** — per-project WS client. Port from `dev3:src/lib/sync/ws-reconciler.ts` (`cc02ca7`) |
| `sync-worker-host.ts` | `apps/workspace/src/lib/sync/sync-worker-host.ts` | **MISSING** | **MISSING** — URL resolution for mounted apex path. Port from main. |
| `branching-search-read.ts` | `apps/workspace/src/lib/sync/branching-search-read.ts` | **MISSING** | **MISSING** (Phase F) |
| `branching-search-passages-read.ts` | same | **MISSING** | **MISSING** (Phase F) |
| `cqrs-bridge.ts` | `apps/workspace/src/lib/sync/cqrs-bridge.ts` | `src/lib/sync/cqrs-bridge.ts` | **PRESENT-BUT-STALE** — demo 162 lines (Yjs + Y.Doc coupling); main 55 lines (slim shim only: setCqrsOutboxBridge / getCqrsOutboxBridge + sync-token fetcher) |
| `cqrs-types.ts` | `apps/workspace/src/lib/sync/cqrs-types.ts` | `src/lib/sync/cqrs-types.ts` | **PRESENT-BUT-STALE** — likely references old event kind names |
| `outbox.ts` | `apps/workspace/src/lib/sync/outbox.ts` | `src/lib/sync/outbox.ts` | **PRESENT-BUT-STALE** — missing `enqueueOutboxEvents` (bulk enqueue; added in main for importer). Everything else matches. |
| `outbox-flush.ts` | `apps/workspace/src/lib/sync/outbox-flush.ts` | `src/lib/sync/outbox-flush.ts` | **PRESENT-AND-CURRENT** (diff returns empty) |
| `audit-stats-overlay.ts` | `apps/workspace/src/lib/sync/audit-stats-overlay.ts` | `src/lib/sync/audit-stats-overlay.ts` | likely stale — touches old cells schema via audit stats |
| `cloud-projects.ts` | `apps/workspace/src/lib/sync/cloud-projects.ts` | `src/lib/sync/cloud-projects.ts` | **PRESENT-BUT-STALE** — has Yjs comment reference (comment only, no real import) but may reference old project shape |
| `commit-message.ts` | `apps/workspace/src/lib/sync/commit-message.ts` | `src/lib/sync/commit-message.ts` | likely current |
| `file-projection.ts` | `apps/workspace/src/lib/sync/file-projection.ts` | `src/lib/sync/file-projection.ts` | likely stale |
| `sync-worker-url.ts` | `apps/workspace/src/lib/sync/sync-worker-url.ts` | `src/lib/sync/sync-worker-url.ts` | likely stale (main replaces with `sync-worker-host.ts`) |
| `partyserver-provider.ts` | **DELETED on main** | `src/lib/sync/partyserver-provider.ts` | demo-only (Yjs) — **delete** |
| `y-partyserver-spike.test.ts` | **DELETED on main** | `src/lib/sync/y-partyserver-spike.test.ts` | demo-only (Yjs) — **delete** |

### New hooks missing from demo (main-only)

| Hook | Main path | Demo status | Source to port from |
|---|---|---|---|
| `useFocusLock.ts` | `apps/workspace/src/hooks/useFocusLock.ts` | **MISSING** | `dev3:src/hooks/useFocusLock.ts` (`cc02ca7`) |
| `useSync.ts` | `apps/workspace/src/hooks/useSync.ts` | **MISSING** | `dev3:src/hooks/useSync.ts` (`5baa91d`) |
| `useCellValidators.ts` | `apps/workspace/src/hooks/useCellValidators.ts` | **MISSING** | main |
| `useCellEditHistory.ts` | `apps/workspace/src/hooks/useCellEditHistory.ts` | **MISSING** | `dev3:src/hooks/useCellEditHistory.ts` (`5baa91d`) |
| `useDownstreamProjects.ts` | `apps/workspace/src/hooks/useDownstreamProjects.ts` | **MISSING** | main |
| `useProjectSource.ts` | `apps/workspace/src/hooks/useProjectSource.ts` | **MISSING** | main |
| `useStaleSourceCells.ts` | `apps/workspace/src/hooks/useStaleSourceCells.ts` | **MISSING** | main |
| `useDeployVersionCheck.ts` | `apps/workspace/src/hooks/useDeployVersionCheck.ts` | **MISSING** | main |
| `useOutboxFlusher.ts` | `apps/workspace/src/hooks/useOutboxFlusher.ts` | `src/hooks/useOutboxFlusher.ts` | demo already has it |

---

## Section 4 — Outbox + DO Diff (Phase A.3)

### 4.1 `src/lib/sync/outbox.ts`

| Feature | Demo | Main |
|---|---|---|
| `enqueueOutboxEvent(event)` | YES | YES |
| `enqueueOutboxEvents(events[])` — bulk | **NO** | **YES** — added for importer bulk enqueue in a single IDB tx (prevents re-render storm) |
| `removeOutboxRecord(id)` | YES | YES |
| `markOutboxAttempt(id, ...)` | YES | YES |
| `subscribeToOutbox(cb)` | YES | YES |
| `resetOutboxConnectionForTests()` | YES | YES |

**Action:** Add `enqueueOutboxEvents` from `main:apps/workspace/src/lib/sync/outbox.ts` (lines 142–181).

### 4.2 `src/lib/sync/outbox-flush.ts`

**PRESENT-AND-CURRENT** — diff returns empty. No changes needed.

### 4.3 `sync-worker/src/events/realtime.ts`

**PRESENT-BUT-STALE** — Minor diff only: `event` message type is missing `by?: string` field.

```diff
// Demo missing in event message type:
+      by?: string  // actor username for client-side self-filter
```

Main adds `...(typeof m.by === 'string' ? { by: m.by } : {})` in `parseRealtimeMessage`. Small, safe add.

### 4.4 Per-project DO (presence + focus-lock + broadcast) — MISSING

Demo has no `ProjectSync` DO. Demo's `FileSync` DO is the y-partyserver Yjs DO — it handles Yjs sync, NOT the events-based presence/focus-lock model.

Files needed for demo (all MISSING):

| File | Port from | Description |
|---|---|---|
| `sync-worker/src/project-do.ts` | `dev3:sync-worker/src/project-do.ts` @ `cc02ca7` | ProjectSync DurableObject class |
| `sync-worker/src/project-do-handlers.ts` | `dev3:sync-worker/src/project-do-handlers.ts` @ `cc02ca7` | Pure state-transition functions (testable) |
| `sync-worker/src/project-do-types.ts` | `dev3:sync-worker/src/project-do-types.ts` @ `cc02ca7` | Types shared between DO and handlers |

The DO must be:
1. Exported from `sync-worker/src/index.ts` as `export { ProjectSync } from "./project-do"`
2. Bound in `sync-worker/wrangler.toml` as a new DO binding (replace or add alongside `FileSync`)
3. Registered in the main `fetch` handler

### 4.5 `sync-worker/src/index.ts` rewrite scope

Demo's `index.ts` (197 lines) uses `YServer` / `FileSync` / partyserver routing — fundamentally incompatible with main. Main's `index.ts` exports `ProjectSync`, wires all read routes, strips Yjs entirely.

**Action:** Full rewrite following `main:apps/sync/src/index.ts` — translate `AQUILLA_DB` → `CODEX_DB` until Phase C renames.

---

## Section 5 — Phase B Yjs File Map

**98 files** in demo reference `yjs`, `Y.Doc`, `y-indexeddb`, `y-prosemirror`, or `@tiptap/extension-collaboration`. The table below covers all of them.

Legend:
- **port main** — fetch `git show main:apps/workspace/<path>` and write to `src/<path>`
- **port dev3** — fetch from dev3 commit (demo-layout compatible; fewer path conflicts)
- **delete** — file has no main equivalent; remove outright
- **delete (sync-worker)** — sync-worker Yjs file; remove
- **rewrite slim** — file stays but content replaces Yjs with thin equivalent
- **comment-only** — Yjs reference is in a comment, no import; minor edit only

### 5.1 Components (15 files)

| Demo file | Lines demo→main | Status on main | Strategy |
|---|---|---|---|
| `src/components/EditorTable.tsx` | 2158 → 2139 | Rewritten without Y.Doc props | **port main** from `apps/workspace/src/components/EditorTable.tsx` |
| `src/components/ProjectWorkspace.tsx` | 1339 → 1701 | Rewritten — larger (adds ProjectSync WS wiring) | **port main** from `apps/workspace/src/components/ProjectWorkspace.tsx` |
| `src/components/TranslatedEditor.tsx` | 295 → 381 | Rewritten as plain TipTap (no Collaboration ext) | **port main** from `apps/workspace/src/components/TranslatedEditor.tsx` (see §6) |
| `src/components/CommentsPage.tsx` | 260 → 30 | Drastically simplified (no Y.Doc) | **port main** from `apps/workspace/src/components/CommentsPage.tsx` |
| `src/components/ParallelPassagesPanel.tsx` | 436 → 59 | Drastically simplified | **port main** from `apps/workspace/src/components/ParallelPassagesPanel.tsx` |
| `src/components/VoiceBar.tsx` | 623 → 38 | Drastically simplified | **port main** from `apps/workspace/src/components/VoiceBar.tsx` |
| `src/components/SelectionBar.tsx` | 303 → 193 | Simplified | **port main** from `apps/workspace/src/components/SelectionBar.tsx` |
| `src/components/RuleDrawer.tsx` | 170 → 123 | Simplified | **port main** from `apps/workspace/src/components/RuleDrawer.tsx` |
| `src/components/HistoryDrawer.tsx` | 263 → 269 | Similar size | **port main** from `apps/workspace/src/components/HistoryDrawer.tsx` |
| `src/components/CellTranscriptPreview.tsx` | 135 → 115 | Simplified | **port main** from `apps/workspace/src/components/CellTranscriptPreview.tsx` |
| `src/components/CellActionsMenu.tsx` | 140 → 140 | Same size | **port main** from `apps/workspace/src/components/CellActionsMenu.tsx` |
| `src/components/CellTranscribeBadge.tsx` | 138 → 138 | Same size | **port main** from `apps/workspace/src/components/CellTranscribeBadge.tsx` |
| `src/components/AudioRecorder/AudioRecordingModal.tsx` | 478 → 440 | Slightly smaller | **port main** from `apps/workspace/src/components/AudioRecorder/AudioRecordingModal.tsx` |
| `src/components/TranslatedEditor.karaoke.test.tsx` | — | exists on main | **port main** from `apps/workspace/src/components/TranslatedEditor.karaoke.test.tsx` |
| `src/components/CellTranscriptPreview.test.tsx` | — | exists on main | **port main** from `apps/workspace/src/components/CellTranscriptPreview.test.tsx` |

### 5.2 Hooks — Yjs hooks to delete (6 files, no main equivalent)

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/hooks/useFileDoc.ts` | **DELETED** | **delete** |
| `src/hooks/useCompositeHealth.ts` | **DELETED** | **delete** |
| `src/hooks/useAutofix.ts` | **DELETED** | **delete** |
| `src/hooks/useAutofix.test.tsx` | **DELETED** | **delete** |
| `src/hooks/useBacktranslation.ts` | **DELETED** | **delete** |
| `src/hooks/useVideoAttachment.ts` | **DELETED** | **delete** |
| `src/hooks/useProjectSettingsSync.ts` | **DELETED** | **delete** |
| `src/hooks/useProjectTombstoneObserver.ts` | **DELETED** | **delete** |

### 5.3 Hooks — Yjs hooks with main equivalents (rewrite) (12 files)

| Demo file | Lines demo→main | Status on main | Strategy |
|---|---|---|---|
| `src/hooks/useCells.ts` | — → — | Rewritten on thin fetcher + outbox | **port dev3** @ `5baa91d:src/hooks/useCells.ts` or main `apps/workspace/src/hooks/useCells.ts` |
| `src/hooks/useCells.test.ts` | — → — | Rewritten | **port dev3** @ `5baa91d:src/hooks/useCells.test.tsx` → rename `.tsx` |
| `src/hooks/useCells.stats.test.tsx` | — | see useCells | **port main** |
| `src/hooks/useCells.validation.test.tsx` | — | see useCells | **port main** |
| `src/hooks/useCellHistory.ts` | — → — | Rewrote on `history-read.ts` | **port dev3** @ `5baa91d:src/hooks/useCellHistory.ts` |
| `src/hooks/useCellWaivers.ts` | — → — | Rewritten | **port main** `apps/workspace/src/hooks/useCellWaivers.ts` |
| `src/hooks/useCellWaivers.test.ts` | — | — | **port main** |
| `src/hooks/useCellsAuditStats.ts` | — → — | Rewritten on audit stats read | **port dev3** @ `5baa91d:src/hooks/useCellsAuditStats.ts` |
| `src/hooks/useCellsAuditStats.test.tsx` | — | see above | **port dev3** |
| `src/hooks/useComments.ts` | — → — | Rewritten on thin fetcher | **port main** `apps/workspace/src/hooks/useComments.ts` |
| `src/hooks/useCompletion.ts` | — → — | Rewritten | **port main** `apps/workspace/src/hooks/useCompletion.ts` |
| `src/hooks/useFileMeta.ts` | — → — | Rewritten on `files-read.ts` | **port dev3** @ `5baa91d:src/hooks/useFileMeta.ts` |
| `src/hooks/useFileMeta.test.ts` | — | — | **port dev3** |
| `src/hooks/useFileSync.ts` | — → — | Rewritten — now manages ProjectSync WS | **port dev3** @ `5baa91d:src/hooks/useFileSync.ts` |
| `src/hooks/useHealth.ts` | — → — | Rewritten on decay model | **port main** `apps/workspace/src/hooks/useHealth.ts` |
| `src/hooks/useHealth.test.tsx` | — | — | **port main** |
| `src/hooks/useProject.ts` | — → — | Rewritten as thin-client | **port dev3** @ `c323b77:src/hooks/useProject.ts` |
| `src/hooks/useSectionProgress.ts` | — → — | Rewritten | **port main** `apps/workspace/src/hooks/useSectionProgress.ts` |
| `src/hooks/useSectionProgress.test.tsx` | — | — | **port main** |

### 5.4 `lib/codex-editor/edits/` — 9 files

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/codex-editor/edits/yjs-helpers.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/yjs-helpers.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/commit-cell-edit.ts` | **DELETED** (logic moved to `events-emit.ts`) | **delete** |
| `src/lib/codex-editor/edits/commit-cell-edit.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/commit-meta-edit.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/commit-meta-edit.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/seed-from-source.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/seed-from-source.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/toggle-cell-validation.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/toggle-cell-validation.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/edits/types.ts` | **DELETED** | **delete** |

### 5.5 `lib/codex-editor/serialize/` — 5 files

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/codex-editor/serialize/cell.ts` | **DELETED** (projection moves server-side) | **delete** |
| `src/lib/codex-editor/serialize/cell.test.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/serialize/comments.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/serialize/file.ts` | **DELETED** | **delete** |
| `src/lib/codex-editor/serialize/file.test.ts` | **DELETED** | **delete** |

Note: main does NOT have a `serialize/` subdirectory under `lib/codex-editor`. The entire folder goes.

### 5.6 `lib/store/` — 4 files

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/store/file-doc.ts` | **DELETED** | **delete** |
| `src/lib/store/file-doc.rehydrate.test.ts` | **DELETED** | **delete** |
| `src/lib/store/snapshots.ts` | **DELETED** | **delete** |
| `src/lib/store/snapshots.test.ts` | **DELETED** | **delete** |

Note: main's `apps/workspace/src/lib/store/` has `file-operations.ts`, `project-index.ts`, `user-api-keys.ts`, `user-provider-override.ts` — these are new files that may need to be ported (not Yjs-related, check individually).

### 5.7 `lib/audio/` — 8 files

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/audio/attach.ts` | **DELETED** (audio writeback via events now) | **delete** |
| `src/lib/audio/bulk-audio.ts` | **DELETED** | **delete** |
| `src/lib/audio/bulk-selected.ts` | **DELETED** | **delete** |
| `src/lib/audio/cell-tts-settings.ts` | **DELETED** | **delete** |
| `src/lib/audio/synth-and-attach.ts` | **DELETED** | **delete** |
| `src/lib/audio/transcribe.ts` | **DELETED** | **delete** |
| `src/lib/audio/timings.ts` | `apps/workspace/src/lib/audio/timings.ts` | **port main** (exists, Yjs writeback removed) |
| `src/lib/audio/timings.test.ts` | `apps/workspace/src/lib/audio/timings.test.ts` | **port main** |
| `src/lib/audio/transcribe-status.ts` | `apps/workspace/src/lib/audio/transcribe-status.ts` | **port main** |

### 5.8 `lib/richtext/` — 2 files

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/richtext/translated-xml.ts` | `apps/workspace/src/lib/richtext/` — rewritten as XML ↔ plain TipTap (no Y.XmlFragment) | **port main** from `apps/workspace/src/lib/richtext/translated-xml.ts` |
| `src/lib/richtext/translated-xml.test.ts` | exists on main | **port main** |

### 5.9 `lib/search/` — 1 file

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/search/replace-action.ts` | `apps/workspace/src/lib/search/replace-action.ts` — Yjs path replaced by event emit | **port main** |

### 5.10 `lib/sync/` — Yjs files (see Section 3 for full table)

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/sync/partyserver-provider.ts` | **DELETED** | **delete** |
| `src/lib/sync/y-partyserver-spike.test.ts` | **DELETED** | **delete** |
| `src/lib/sync/cqrs-bridge.ts` | rewritten as slim shim (55 lines) | **port main** `apps/workspace/src/lib/sync/cqrs-bridge.ts` |
| `src/lib/sync/cqrs-types.ts` | exists, likely updated | **port main** (check for old event kind refs) |
| `src/lib/sync/cloud-projects.ts` | exists, comment-only Yjs ref | **port main** (remove Yjs comment) |

### 5.11 `lib/editor/` — 1 file (partial)

| Demo file | Status on main | Strategy |
|---|---|---|
| `src/lib/editor/cell-area-state.test.ts` | `apps/workspace/src/lib/editor/cell-area-state.test.ts` | **port main** |

### 5.12 `lib/parsers/types.ts` — comment-only

Yjs appears only in a comment (`/* Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */`). No import. Minor edit: remove the Y.Doc comment reference.

### 5.13 `src/index.css` — 2 lines

Lines 74–84 define `.ProseMirror-yjs-cursor` CSS. **Delete** those rules in Step 3.

### 5.14 `sync-worker/src/` — Yjs files (delete)

| Demo file | Status on main | Strategy |
|---|---|---|
| `sync-worker/src/projection.ts` | **DELETED** | **delete** |
| `sync-worker/src/incremental.ts` | **DELETED** | **delete** |
| `sync-worker/src/events/html-to-fragment.ts` | **DELETED** | **delete** |
| `sync-worker/src/events/hydrate.ts` | **DELETED** | **delete** |
| `sync-worker/src/events/apply-event.ts` | **DELETED** (logic absorbed into `event-projection.ts` on main) | **delete** |
| `sync-worker/src/index.ts` | rewritten (no YServer, no partyserver) | **rewrite** per main |

### 5.15 `sync-worker/src/` test files with Yjs refs — likely deletable once source files go

| Demo file | Notes |
|---|---|
| `sync-worker/src/__tests__/compaction.test.ts` | Tests compaction via Y.Doc — **delete** (no compaction on main) |
| `sync-worker/src/__tests__/helpers/d1-fake.ts` | May have Yjs helpers — **port main** `apps/sync/src/__tests__/helpers/d1-fake.ts` |
| `sync-worker/src/__tests__/html-to-fragment.test.ts` | Tests `html-to-fragment.ts` — **delete** |
| `sync-worker/src/__tests__/hydrate.test.ts` | Tests `hydrate.ts` — **delete** |
| `sync-worker/src/__tests__/incremental.test.ts` | Tests `incremental.ts` — **delete** |
| `sync-worker/src/__tests__/projection.test.ts` | Tests `projection.ts` — **delete** |
| `sync-worker/src/auth.ts` | Yjs reference is string literal in comment — **minor edit** only |
| `sync-worker/src/events/cells-audit-read-route.ts` | Yjs in comment only — **port main** version instead |
| `sync-worker/src/events/event-projection.ts` | Imports Y via old schema — **full replacement** |
| `sync-worker/src/events/types.ts` | Old EventKind — **full replacement** |
| `sync-worker/src/project-archive.ts` | Yjs in comment + old broadcast logic — **port main** |

---

## Section 6 — TipTap Config Diff (Phase B.3)

### Demo `src/components/TranslatedEditor.tsx` (295 lines)

Imports:
```ts
import Collaboration from "@tiptap/extension-collaboration"
import { Extension } from "@tiptap/core"
import { yCursorPlugin } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import type YProvider from "y-partyserver/provider"
```

Props interface: `{ fragment: Y.XmlFragment, syncProvider?: YProvider | null, user?: ... }`

TipTap extensions list:
```ts
StarterKit.configure({ undoRedo: false, heading: false, ... }),
Collaboration.configure({ fragment }),
...(syncProvider && user ? [createCollabCursorExtension(syncProvider, user)] : []),
createViolationDecorationExtension(...),
createKaraokeExtension(...),
```

### Main `apps/workspace/src/components/TranslatedEditor.tsx` (381 lines)

Imports: **no Yjs, no Collaboration**
```ts
import { useEditor, EditorContent } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
// ... (no Y.Doc, no Collaboration)
```

Props interface:
```ts
{
  cellId: string          // stable id for remount detection
  initialHtml?: string
  initialPlain: string
  onCommit: (snapshot: TranslatedEditorCommit) => void
  onFocus?: () => void
  onBlur?: () => void
  heldByLabel?: string    // from useFocusLock — when set, editor goes read-only
  infractions?: RuleInfraction[]
  ...
}
```

TipTap extensions:
```ts
StarterKit.configure({
  // undoRedo: TRUE (native history restored; Yjs undo removed)
  heading: false, bulletList: false, ...
}),
createViolationDecorationExtension(...),
createKaraokeExtension(...),
// No Collaboration, no CollaborationCursor
```

**Delta summary:** Remove `Collaboration`, `yCursorPlugin`, `Y.XmlFragment` prop. Add `cellId`, `initialHtml/initialPlain`, `onCommit`, `heldByLabel`. Restore native TipTap undo/redo. Add debounced commit timer.

---

## Section 7 — Three-Step Rip Order (Phase B.2)

All three commits are on branch `dev3`, NOT on `main`. They use the demo single-app layout.

### Step 1: `88c5df4` — "delete first wave"

**Exact files touched (from `git show 88c5df4 --name-only`):**

Delete these demo files:
- `src/hooks/useAutofix.test.tsx`
- `src/hooks/useAutofix.ts`
- `src/hooks/useBacktranslation.ts`
- `src/hooks/useCellHistory.ts` → replace with thin-client version
- `src/hooks/useCells.ts` → replace with thin-client version
- `src/hooks/useCompletion.ts` → replace
- `src/hooks/useFileDoc.ts` → delete
- `src/hooks/useProjectSettingsSync.ts` → delete
- `src/hooks/useVideoAttachment.ts` → delete
- `src/lib/audio/attach.ts` → delete
- `src/lib/audio/bulk-audio.ts` → delete
- `src/lib/audio/bulk-selected.ts` → delete
- `src/lib/audio/cell-tts-settings.ts` → delete
- `src/lib/audio/synth-and-attach.ts` → delete
- `src/lib/audio/timings.test.ts` → port main version
- `src/lib/audio/timings.ts` → port main version
- `src/lib/audio/transcribe.test.ts` → delete
- `src/lib/audio/transcribe.ts` → delete
- `src/lib/codex-editor/edits/commit-cell-edit.test.ts` → delete
- `src/lib/codex-editor/edits/commit-cell-edit.ts` → delete
- `src/lib/codex-editor/edits/commit-meta-edit.test.ts` → delete
- `src/lib/codex-editor/edits/commit-meta-edit.ts` → delete
- `src/lib/codex-editor/edits/seed-from-source.test.ts` → delete
- `src/lib/codex-editor/edits/seed-from-source.ts` → delete
- `src/lib/codex-editor/edits/toggle-cell-validation.test.ts` → delete
- `src/lib/codex-editor/edits/toggle-cell-validation.ts` → delete
- `src/lib/codex-editor/edits/types.ts` → delete
- `src/lib/codex-editor/edits/yjs-helpers.test.ts` → delete
- `src/lib/codex-editor/edits/yjs-helpers.ts` → delete
- `src/lib/codex-editor/serialize/cell.test.ts` → delete
- `src/lib/codex-editor/serialize/cell.ts` → delete
- `src/lib/codex-editor/serialize/comments.ts` → delete
- `src/lib/codex-editor/serialize/file.test.ts` → delete
- `src/lib/codex-editor/serialize/file.ts` → delete
- `src/lib/codex-editor/serialize/index.ts` → delete (not detected by rg but touched in commit)
- `src/lib/codex-editor/serialize/metadata.ts` → delete (not detected by rg but touched in commit)
- `src/lib/export/export-service.ts` → port main version (Yjs refs removed)
- `src/lib/export/rebuilders/markdown.ts` → port main
- `src/lib/export/rebuilders/plaintext.ts` → port main
- `src/lib/export/rebuilders/rebuilders.test.ts` → port main
- `src/lib/export/rebuilders/subtitle.ts` → port main
- `src/lib/export/rebuilders/usfm.ts` → port main
- `src/lib/export/surgical-export.test.ts` → port main
- `src/lib/export/surgical-export.ts` → port main
- `src/lib/richtext/translated-xml.test.ts` → port main
- `src/lib/richtext/translated-xml.ts` → port main
- `src/lib/search/replace-action.test.ts` → port main
- `src/lib/search/replace-action.ts` → port main
- `src/lib/search/workspace-index.test.ts` → port main (if changed)
- `src/lib/search/workspace-index.ts` → port main
- `src/lib/store/file-doc.rehydrate.test.ts` → delete
- `src/lib/store/file-doc.ts` → delete
- `src/lib/store/snapshots.test.ts` → delete
- `src/lib/store/snapshots.ts` → delete
- `src/lib/sync/cqrs-bridge.test.ts` → port main (slim shim test)
- `src/lib/sync/cqrs-bridge.ts` → port main (slim shim)
- `src/lib/sync/cqrs-types.ts` → port main

### Step 2: `e6867f6` — "untangle ProjectWorkspace/EditorTable/feature-page"

**Exact files touched:**
- `src/components/AudioBulkProgressBanner.tsx` — port main (if Yjs involved; check)
- `src/components/AudioRecorder/AudioRecordingModal.tsx` → port main
- `src/components/CellTranscriptPreview.test.tsx` → port main
- `src/components/CellTranscriptPreview.tsx` → port main
- `src/components/CommentsPage.tsx` → port main
- `src/components/EditorTable.tsx` → port main
- `src/components/LivingMemoryPage.tsx` → port main (if exists on demo)
- `src/components/OutboxInspectorPopover.tsx` → port main (if exists on demo)
- `src/components/ParallelPassagesPanel.tsx` → port main
- `src/components/ProjectWorkspace.tsx` → port main
- `src/components/RuleDrawer.tsx` → port main
- `src/components/RuleSuggestDialog.tsx` → port main (if exists on demo)
- `src/components/SelectionBar.tsx` → port main
- `src/components/SnapshotCreateDialog.tsx` → port main (if exists on demo)
- `src/components/SnapshotsPage.tsx` → port main (if exists on demo)
- `src/components/VoiceBar.tsx` → port main
- `src/hooks/useWorkspaceSearch.ts` → port main
- `src/lib/editor/cell-area-state.test.ts` → port main
- `src/lib/editor/cell-area-state.ts` → port main
- `src/lib/search/workspace-index.ts` → port main (updated again)
- `src/lib/sync/audit-stats-overlay.test.ts` → port main
- `src/lib/sync/audit-stats-overlay.ts` → port main
- `src/lib/sync/cqrs-bridge.ts` → port main (updated again in this commit)
- `src/lib/sync/cqrs-types.ts` → port main
- `src/lib/sync/outbox-flush.test.ts` → likely no change
- `src/lib/sync/outbox.test.ts` → likely no change

### Step 3: `e4cf552` — "remove deps"

**Exact files touched:**
- `apps/workspace/package.json` → translate: `package.json` (root) on demo
- `package.json` (root) → also update
- `pnpm-lock.yaml` → regenerated after

**Command:** `pnpm rm yjs y-indexeddb y-prosemirror @tiptap/extension-collaboration`

Also remove from `sync-worker/package.json`:
- `yjs`
- `y-partyserver`
- `partyserver` (replaced by `cloudflare:workers` DurableObject)

**Verify:** `rg -l 'yjs|Y\.Doc|y-indexeddb|y-prosemirror|@tiptap/extension-collaboration' src/ sync-worker/src/` should return nothing.

---

## Summary Checklist for Implementation Agents

### Phase A prerequisites (do in order)

1. Create `auth-worker/migrations/` with all 14 SQL files from `main:apps/identity/migrations/`
2. Update `sync-worker/wrangler.toml`: add `ProjectSync` DO binding, remove FileSync DO; rename `CODEX_DB` → `AQUILLA_DB` (Phase C, but types.ts stubs can use it now)
3. Port `sync-worker/src/events/types.ts` from main (new prefixed EventKind)
4. Port `sync-worker/src/events/event-projection.ts` from main (AD-2 guard + new cells schema)
5. Port `sync-worker/src/events/dispatch.ts` from main (new handler routing)
6. Port `sync-worker/src/events/role-policy.ts` from main
7. Port `sync-worker/src/events/handlers/cell-events.ts` from main (new unified handler)
8. Port `sync-worker/src/events/handlers/types.ts` from main
9. Delete `sync-worker/src/events/handlers/cell-commit.ts`, `cell-validate.ts`, `cell-unvalidate.ts`, `events-audit-only.ts`
10. Add `sync-worker/src/project-do.ts`, `project-do-handlers.ts`, `project-do-types.ts` from `dev3@cc02ca7`
11. Add missing read routes: `cells-read-route.ts`, `files-read-route.ts`, `cell-history-read-route.ts` from `dev3` or main
12. Update stale routes: `cells-audit-read-route.ts`, `validators-read-route.ts`, `read-route.ts` (CODEX_DB → AQUILLA_DB + schema changes)
13. Rewrite `sync-worker/src/index.ts` (remove YServer, wire ProjectSync, add all routes)
14. Delete `sync-worker/src/projection.ts`, `incremental.ts`, `events/html-to-fragment.ts`, `events/hydrate.ts`, `events/apply-event.ts`
15. Add client files: `src/lib/sync/events-emit.ts`, `outbox-types.ts`, `ws-reconciler.ts`, `cells-read.ts`, `cells-read-types.ts` from `dev3@cc02ca7` + `dev3@63d2ba4`
16. Add `src/lib/sync/events-emit.ts` bulk enqueue to `outbox.ts`
17. Update `src/lib/sync/cqrs-bridge.ts` to slim shim
18. Add `src/hooks/useFocusLock.ts`, `useSync.ts` from `dev3@cc02ca7`, `dev3@5baa91d`

### Phase B (after Phase A passes tests)

Follow three-step rip in order: Step 1 (leaf deletions) → Step 2 (component untangle) → Step 3 (dep removal).

After Step 3: run `pnpm build` and `pnpm test` to verify green.
