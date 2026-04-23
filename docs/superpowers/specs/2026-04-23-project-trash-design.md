# Project Trash (Soft-Delete) — Design

**Date:** 2026-04-23
**Status:** Draft
**Scope:** Owners can move projects to a Trash bin. Tombstone propagates to collaborators with a live banner. Permanent delete is explicitly out of scope.

## Goals

- Owners can remove projects from their dashboard ("Move to Trash") without losing data.
- Trashed projects are recoverable from a Trash view.
- For projects with live collaborators, a Trash action by the owner propagates — dashboards hide the project, and anyone currently editing sees a banner.
- No changes to GitLab-stored data; GitLab stays the backward-compat path.
- Works uniformly whether a project was created locally, imported from Git, or joined via invite.

## Non-Goals

- Permanent delete (future work; R2/D1/DO cleanup is deferred).
- Auto-purge after N days.
- Per-user trash views (trash is project-scoped, not user-scoped).
- GitLab repository deletion.

## Current State (what's already in place)

- `projects.archived_at DATETIME` already exists in frontier-server D1 (migration 0013). `archived_by` does not.
- `resolveProjectRole` already filters `archived_at IS NULL`, so archived projects already 403 from `/api/v2/sync-token` — for all users, including the owner.
- `/sync-token` auto-registers any project a signed-in user opens (creator → implicit owner role 700, via `project_members.created_by`).
- File-level realtime sync is always-on (per-file y-partyserver DO + R2). Every project gets cloud persistence the moment a signed-in user opens a file in it.
- GitLab integration is orthogonal: only `origin.kind === "git"` projects run `syncProject` (push/pull). The trash feature doesn't interact with GitLab at all.

## Data Model

### Frontier-server D1 — migration 0015

```sql
-- Migration: 0015_project_archived_by.sql
ALTER TABLE projects ADD COLUMN archived_by INTEGER REFERENCES users(id);
CREATE INDEX idx_projects_archived ON projects(archived_at) WHERE archived_at IS NOT NULL;
```

Existing `archived_at DATETIME` is reused. No change to `project_members` or any other table.

### Client IDB — `ProjectRecord` additions

```ts
export interface ProjectRecord {
  // ...existing fields
  /** Soft-delete marker. Present → project is in Trash. */
  deletedAt?: string
  /** Display name of the user who archived it. Populated from server or local session. */
  deletedBy?: string
}
```

Purely local projects (never synced) can be trashed IDB-only; these fields do not sync to the server in that case.

## Ownership & Authorization

**Server-side (authoritative):** only a user with role `owner` (level 700) on a project can archive or unarchive it. The sync-token path already derives role via `resolveProjectRole`, but that helper filters out archived projects. The archive endpoints need a variant that includes archived rows.

**New helper:** `resolveProjectRoleIncludingArchived(env, user, projectId)` — identical to `resolveProjectRole` but without the `AND archived_at IS NULL` clause. Used only by the archive/unarchive endpoints and the archive-aware `GET /projects/:id` endpoint.

**Client-side (hint only):**
- Show the "Move to Trash" action if the cached sync role is `>= 700`, or if the project is purely local (local-only owner).
- If the user guesses wrong, the server returns 403 and the UI shows a toast.

**Role caching:** extend `ProjectRecord` with an optional `syncRole?: { level: number; name: string; source: string; fetchedAt: string }` populated from the most recent `/sync-token` response. This avoids a round-trip on dashboard render.

## API Surface (frontier-server)

All under `/api/v2/projects/:id`, auth required (same `authMiddleware` as existing routes).

### `POST /api/v2/projects/:id/archive`
- Body: `{}` (no fields required; `archived_by = authenticated user`)
- Auth: requires resolved role 700 via `resolveProjectRoleIncludingArchived`.
- Sets `archived_at = CURRENT_TIMESTAMP`, `archived_by = user.id` if not already archived (idempotent).
- Response: `{ ok: true, archivedAt, archivedBy: { id, username } }`
- Side effect (propagation): notifies the sync-worker via an internal call so live clients see the tombstone immediately (see "Live propagation" below).

### `DELETE /api/v2/projects/:id/archive`
- Unarchive / restore. Same auth.
- Clears `archived_at` and `archived_by`.
- Response: `{ ok: true }`
- Side effect: notifies sync-worker to clear the `meta.projectDeletedAt` flag on active file rooms (and/or to accept new connections normally).

### `GET /api/v2/projects/:id`
- Returns current state including archive fields.
- Response: `{ id, name, gitlab_project_id, archived_at, archived_by: { id, username } | null, role: { level, name, source } }`.
- Uses `resolveProjectRoleIncludingArchived` so owners can fetch state for archived projects (needed for the Trash view on Dashboard).
- Non-members → 403. Non-existent → 404.

### `GET /api/v2/projects` (optional, convenience)
- Returns all projects the authenticated user is a member of, with archive state. Used by Dashboard to reconcile IDB-vs-server trash state in one round-trip.
- Response: `{ projects: [{ id, name, archived_at, ... }] }`

## Live Propagation (owner archives → live clients see banner)

When an owner archives a project, currently-connected clients viewing any file in that project should be notified within seconds. Three possible channels:

**Chosen approach: DO meta map + sync-worker control endpoint.**

1. Frontier-server's archive endpoint, after updating D1, POSTs to a new sync-worker endpoint `POST /admin/projects/:id/archive` (protected by `SYNC_SECRET_KEY` like the existing `/admin/files/*` endpoint).
2. The sync-worker endpoint enumerates all active DOs in that project (by R2 listing under `projects/:id/files/` to find known fileIds, then checking if any DO stub is live) and writes `{ projectDeletedAt, deletedBy }` into each DO's `meta` Y.Map.
3. Clients already observe `meta` on the Y.Doc (per [useFileSync](src/hooks/useFileSync.ts)); the observer fires on update and the app triggers:
   - Mark `deletedAt` + `deletedBy` on the IDB `ProjectRecord`.
   - Show a sticky banner on the workspace: "This project was moved to Trash by {name}." with "Close" (→ Dashboard) and, if owner, "Restore" actions.
   - Disable writes: the editor switches to read-only; save attempts no-op with a toast.
4. Unarchive clears the `meta.projectDeletedAt` field. Banner disappears, writes re-enable.

**Fallback for disconnected clients:** `/sync-token` already rejects archived projects (line 88 of `project-permissions.ts`), so on next connect attempt the client gets 403. The client interprets 403 + `reason: "archived"` as "move to trash locally" and redirects.

**Open question (decide during implementation):** the naive DO enumeration (R2 list) is fine for our scale but not elegant. If it becomes a bottleneck we can maintain a `DO_STUBS` KV or a D1 table `active_rooms`. For now, R2 list is good enough.

## Client Architecture

### `src/lib/sync/archive.ts` (new)

```ts
export async function archiveProjectRemote(
  projectId: string,
  session: FrontierSession,
): Promise<{ archivedAt: string; deletedBy: string } | { status: "local-only" } | { status: "forbidden" }>

export async function unarchiveProjectRemote(
  projectId: string,
  session: FrontierSession,
): Promise<{ ok: true } | { status: "local-only" } | { status: "forbidden" }>

export async function fetchProjectState(
  projectId: string,
  session: FrontierSession,
): Promise<{ archivedAt?: string; deletedBy?: string; role: { level: number } } | null>
```

- `404` → `"local-only"` (the project has never been registered server-side).
- `403` → `"forbidden"`.

### `src/lib/store/project-index.ts` (modified)

- `listProjects()` — add optional arg `{ includeTrashed?: boolean }`, default false. Filter `!p.deletedAt` by default.
- `listTrashedProjects()` — returns only `p.deletedAt != null`.
- `tombstoneProject(project, session)`:
  1. If `session`, call `archiveProjectRemote`. If `"local-only"`, proceed with IDB-only. If `"forbidden"`, throw (UI shows toast).
  2. On success (or local-only), `patchProject` to set `deletedAt`, `deletedBy`.
- `restoreProject(project, session)` — symmetric.

### Dashboard

Add a collapsible "Trash" section below "Your projects":

```
Your projects
  [ProjectCard] [ProjectCard] ...

[▸ Trash (N)]                    ← collapsed by default when Trash is empty or small
```

`ProjectCard` gains an owner-only `...` dropdown menu (shadcn `DropdownMenu`):
- **Move to Trash** — confirm dialog: "Move '{name}' to Trash? You can restore it later from the Trash section." On confirm, call `tombstoneProject`, update local state.
- In the Trash section, each card shows: **Restore** (primary action) and dimmed metadata (`Deleted by {name} on {date}`).

### Route guards

`/project/:id` workspace route:
- If the loaded `ProjectRecord` has `deletedAt` set: redirect to `/` with a toast "That project is in Trash — restore it to open."
- If the banner activates while already viewing (live propagation): show the sticky banner; workspace stays mounted until the user clicks "Close" (so they don't lose their mental place).

### Workspace banner

Implemented in `ProjectWorkspace.tsx`:

```tsx
{project.deletedAt && (
  <div className="sticky top-0 z-50 bg-destructive text-destructive-foreground px-4 py-2 flex items-center gap-3">
    <span>This project was moved to Trash by {project.deletedBy}.</span>
    {canRestore && <Button size="sm" onClick={handleRestore}>Restore</Button>}
    <Button size="sm" variant="outline" onClick={() => navigate("/")}>Close</Button>
  </div>
)}
```

Writes are blocked while `deletedAt` is set: `EditorTable` reads a `readOnly` prop derived from `project.deletedAt != null`.

## Failure & Edge Cases

- **Owner archives while another owner is editing**: both see the banner (the second owner sees "Restore" since they're also owner).
- **Non-member tries to open archived project URL**: already handled — `/sync-token` returns 403, no data is ever loaded client-side.
- **Network flake during archive call**: show retry toast; don't apply local tombstone until server succeeds (unless `"local-only"`).
- **Unarchive race with concurrent archive**: last writer wins at D1 level; `archived_at` either set or null. The DO meta map is updated to match.
- **Pure-local project on second device**: since it was never synced, only the device that archived it knows. Acceptable — purely-local projects don't have collaborators by definition.
- **Project exists on server but user doesn't have sync role cached**: client attempts the archive, server 403, UI shows "Only project owners can move to Trash."

## Testing Plan

### Frontier-server
- Migration applies cleanly; `archived_by` is nullable.
- `resolveProjectRoleIncludingArchived` returns correct role for archived projects.
- `POST /archive` requires role 700; 403 for lower roles; 404 for non-members.
- `DELETE /archive` is symmetric.
- `GET /projects/:id` returns archive fields and role.
- Idempotency: double-archive is a no-op.

### Sync-worker
- `POST /admin/projects/:id/archive` requires `SYNC_SECRET_KEY`.
- Injecting `meta.projectDeletedAt` into a running DO triggers client observers.
- `/sync-token` rejection for archived projects returns a structured error the client can interpret.

### Client
- `archiveProjectRemote` returns `"local-only"` on 404, `"forbidden"` on 403, `{archivedAt}` on 200.
- `tombstoneProject` falls through to IDB-only when server returns `"local-only"`.
- `listProjects()` filters trashed by default; `listTrashedProjects()` returns them.
- Dashboard Trash section renders correctly.
- Banner renders when `deletedAt` is set; Restore works for owners; writes are disabled.
- Route guard: opening a trashed project URL redirects to Dashboard.

### E2E
- Owner Alice archives a project while collaborator Bob is editing. Within 3s, Bob sees the banner. Bob's dashboard filters the project on next load.
- Alice restores. Bob's banner disappears on refresh or next sync event.

## Implementation Order

1. **Frontier-server**: migration 0015 → `resolveProjectRoleIncludingArchived` → `GET/POST/DELETE` endpoints → tests.
2. **Client types + store**: `ProjectRecord` fields → `archive.ts` lib → `tombstoneProject`/`restoreProject`.
3. **Dashboard UI**: `...` menu → confirm dialog → Trash section → restore.
4. **Workspace guards**: route redirect → banner → readOnly propagation.
5. **Sync-worker propagation**: `/admin/projects/:id/archive` endpoint → DO meta injection → client observer.
6. **Frontier-server side-effect call** to sync-worker in archive/unarchive handlers.
7. **E2E spec** covering the live-banner flow.

Phase 1–4 give a fully-working trash with a page-refresh propagation story. Phases 5–6 upgrade to live-banner. Phase 7 is verification.
