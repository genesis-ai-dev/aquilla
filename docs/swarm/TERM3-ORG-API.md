# TERM3 — Org Termbase Publish/Subscribe API (server contract)

Server-side slice for terminology Slices 6-7
(`docs/superpowers/specs/2026-06-08-terminology-harden-and-discover-design.md`)
and `aquilla-specs/04-features/terminology.md` §"Termbase — sharing across
projects".

The client agent builds against this contract.

## Source of truth

- Routes: `auth-worker/src/routes/termbase-subscriptions.ts`
- Migration (D1/Neon audit trail): `auth-worker/migrations/0030_termbase_subscriptions.sql`
- Canonical schema (what the test PGlite + live Neon load):
  `db/postgres/schema.sql` — carries the same additive DDL.
- Tests: `auth-worker/src/__tests__/termbase-subscriptions.test.ts`

## Data model (additive — migration 0030)

- `projects.org_published_termbase BOOLEAN NOT NULL DEFAULT FALSE` — publish flag.
- `project_termbase_subscriptions(project_id TEXT, termbase_project_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())`
  with PK `(project_id, termbase_project_id)`. Lower `priority` = higher
  precedence. Subscription is idempotent on the PK.

## Roles

viewer 100 · contributor 400 · project_lead 500 · maintainer 600 · owner 700.
Project roles resolve via `resolveProjectRole` (AD-12 max-wins across
direct/group/org/creator). All routes require `authMiddleware` (Bearer JWT).

## Endpoints

### 1. POST `/api/v2/projects/:id/termbase/publish` — maintainer 600+
Project must be org-owned (`org_id` not null).
- 200 `{ projectId, published: true }`
- 403 no access / role below maintainer
- 404 `{ error: "project not found" }`
- 409 `{ error: "project is not org-owned; cannot publish to an org" }`

### 2. DELETE `/api/v2/projects/:id/termbase/publish` — maintainer 600+
Sets `org_published_termbase=false`. Existing subscriptions are not deleted
(they go inert; the published listing hides the upstream).
- 200 `{ projectId, published: false }`

### 3. GET `/api/v2/orgs/:orgId/published-termbases` — any org member
- 200 `{ termbases: [{ projectId, name, createdBy }] }`
- 403 not an org member

### 4. GET `/api/v2/projects/:id/termbase/subscriptions` — viewer 100+ on project
- 200 `{ subscriptions: [{ termbaseProjectId, termbaseName, priority, createdAt, published }] }`
  ordered by `priority` asc then `createdAt`.

### 5. POST `/api/v2/projects/:id/termbase/subscriptions` — maintainer 600+
Body `{ termbaseProjectId: string, priority?: number }`. The termbase must be
published to the SAME org. Idempotent on `(project_id, termbase_project_id)`:
re-POST updates priority. When `priority` is omitted it appends at the end.
- 200 `{ subscription: { termbaseProjectId, priority, createdAt } }`
- 400 `{ error: "cannot subscribe a project to its own termbase" }`
- 404 `{ error: "termbase project not found" }` / `{ error: "project not found" }`
- 409 `{ error: "termbase is not published to this org" }` (unpublished or cross-org)

### 6. DELETE `/api/v2/projects/:id/termbase/subscriptions/:termbaseProjectId` — maintainer 600+
- 200 `{ ok: true }`

### 7. PATCH `/api/v2/projects/:id/termbase/subscriptions` — maintainer 600+
Body `{ order: string[] }` — `termbaseProjectId`s in desired precedence;
index 0 = priority 0 = highest precedence. Unknown ids are ignored.
- 200 `{ subscriptions: [...] }` (same shape as GET)

## Implicit grant (Q19)

A subscription row confers an implicit **viewer** read on the upstream termbase
project, scoped to termbase data only — mirroring the source-project link
pattern (`canReadSourceCells` in `services/project-permissions.ts`). The read is
**derived from the subscription row at resolve time**; no `project_members`
write is performed (so unsubscribing instantly revokes it, and it never leaks
into the members UI).

**SWARM-TODO (client/terminology agent):** the upstream termbase READ resolver
— analogous to `canReadSourceCells`, e.g.
`canReadTermbase(viewerProjectId, termbaseProjectId)` returning true when a
`project_termbase_subscriptions(viewerProjectId, termbaseProjectId)` row exists
— must be wired into the termbase-DATA read endpoints (which live outside this
server slice). This module owns only the subscription rows such a resolver
reads.

## SWARM-TODO (orchestrator) — apply migration to live Neon

Migration `auth-worker/migrations/0030_termbase_subscriptions.sql` has **NOT**
been applied to live Neon/D1. Per the documented D1→Neon schema-drift caution
(post-cutover 500s are usually a migration never applied to live Neon), the
orchestrator must, after review:

1. Diff live Neon against `db/postgres/schema.sql`.
2. Apply the additive DDL from `0030` (the `projects.org_published_termbase`
   column + `project_termbase_subscriptions` table + indexes) to live Neon.

The additions are fully additive (no destructive change to existing tables), so
they are safe to apply online.

## Verification

From `auth-worker/`:
- `npx tsc --noEmit` → 0 errors
- `npm test` → green (see `termbase-subscriptions.test.ts`)
