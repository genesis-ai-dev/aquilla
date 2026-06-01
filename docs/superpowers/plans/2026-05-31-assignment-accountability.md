# Assignment & Accountability — Slice 1 Plan (Phase C)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`. Build on branch `assignment-accountability` in worktree `.claude/worktrees/assignment` (off current main). The user is ACTIVELY committing to the sync-worker event core — re-merge current main + resolve event-core overlap at each landing.

**Goal:** A manager (project_lead 500+) assigns a **book or chapter** scope to a member; the org Overview shows **per-member workload/progress**; the assignee sees an **"Assigned to me" inbox**. One `assignment.create` event regardless of scope size.

**Architecture:** A v1 project-level event family `assignment.create / .reassign / .unassign` (like `comment.*` — no fileId/cellId, `parentId` null), projected by sync-worker into two D1 tables (`assignments` + `assignment_cells`). Progress is **derived on read** (count assigned cells that are validated/committed) so slice 1 never touches the hot `cell.commit` path. Defer: cell-gutter avatars, full Members Matrix, `cells`/`verses` scope, server-emitted `.complete`.

**Tech Stack:** Hono + D1 (real-D1 vitest harness for auth-worker; stub-DB + signed-token for sync-worker, per export-route.test.ts); React + RTL.

---

### Task AS1: Backend — migration + event family + projector

> **STATUS: ✅ DONE (commit `ef3c81c` on `assignment-accountability`).** Deliberate deviations from the draft below: (1) migration is **0022** not 0021 — the user's `0021_cell_backtranslations` landed on main first, so I merged current main (`3385df2`) into the branch before building; (2) **no `deleted_at` filter** in the resolver — the sync-worker `cells` projection hard-deletes (no such column); (3) handler is **self-contained** (does NOT delegate to `buildEventProjectionStmts`) because it needs `claims.userId` for `created_by`, which `PersistedEvent` doesn't carry — a documented throwing case keeps the projector exhaustiveness happy; (4) timestamps are INTEGER unix-ms (like comments), `deadline` is an ISO string (like `projects.deadline_at`). sync-worker tsc clean, **389/389 tests pass**.

**Files:** create `auth-worker/migrations/0022_assignments.sql`; modify `sync-worker/src/events/types.ts`, `role-policy.ts`, `dispatch.ts`, `route.ts`, `realtime.ts`, `event-projection.ts`; create `sync-worker/src/events/handlers/assignment-events.ts`; tests `assignment-events.test.ts` (+ `helpers/d1-fake.ts`, `dispatch.test.ts`, `role-policy.test.ts`, `realtime.test.ts`).

- [ ] **Migration `0021_assignments.sql`:**

```sql
-- 0021_assignments.sql — manager work assignment (assign-cell-to-member, slice 1).
CREATE TABLE assignments (
  assignment_id    TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  assignee_user_id INTEGER NOT NULL,
  scope_kind       TEXT NOT NULL,            -- 'chapters' | 'books'
  scope_label      TEXT NOT NULL,
  cells_total      INTEGER NOT NULL DEFAULT 0,
  deadline         DATETIME,
  note             TEXT,
  created_by       INTEGER NOT NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  unassigned_at    DATETIME,
  completed_at     DATETIME
);
CREATE INDEX idx_assignments_project  ON assignments(project_id);
CREATE INDEX idx_assignments_assignee ON assignments(assignee_user_id);
CREATE TABLE assignment_cells (
  assignment_id TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  cell_id       TEXT NOT NULL,
  PRIMARY KEY (assignment_id, file_id, cell_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE
);
```

- [ ] **types.ts** — add to `EventKind`: `'assignment.create' | 'assignment.reassign' | 'assignment.unassign'`; add to `EventPayloads`:

```ts
  'assignment.create': {
    assignmentId: string
    scopeKind: 'chapters' | 'books'
    /** chapter present for 'chapters' (e.g. {fileId, chapter:"GEN 1"}); fileId-only for 'books'. */
    scope: { fileId: string; chapter?: string }[]
    scopeLabel: string
    assigneeUserId: number
    deadline?: string | null
    note?: string | null
  }
  'assignment.reassign': { assignmentId: string; assigneeUserId: number }
  'assignment.unassign': { assignmentId: string }
```

- [ ] **role-policy.ts** — `REQUIRED_ROLE`: `'assignment.create' | '.reassign' | '.unassign'` → `ROLE.PROJECT_LEAD` (500). (TS exhaustiveness will force these.)

- [ ] **dispatch.ts** — route the three kinds to `handleAssignmentEvent` (project-level: no parent-chain guard, like comment.*).

- [ ] **handlers/assignment-events.ts** — mirror `comment-events.ts` + the current server_seq derivation:
  - `create`: INSERT `assignments`; resolve scope → cell set from the `cells` projection — books: `SELECT file_id, cell_id FROM cells WHERE project_id=? AND file_id=? AND side='source' AND deleted_at IS NULL`; chapters: same + `AND canonical_ref LIKE ? ` (`"<chapter>:%"`). INSERT `assignment_cells` (chunk ~95 binds); `UPDATE assignments SET cells_total=?`.
  - `reassign`: `UPDATE assignments SET assignee_user_id=? WHERE assignment_id=? AND project_id=?`.
  - `unassign`: `UPDATE assignments SET unassigned_at=CURRENT_TIMESTAMP WHERE assignment_id=? AND project_id=?`.

- [ ] **Test** (`assignment-events.test.ts`, stub-DB + signed token like export-route.test.ts, OR real-D1 if the sync-worker harness supports it): a project_lead `assignment.create` with `scopeKind:'books'` over a seeded file → `assignments` row + N `assignment_cells`; a sub-project_lead (reviewer 300) → 403; reassign updates `assignee_user_id`; unassign sets `unassigned_at`.
- [ ] **Commit.**

---

### Task AS2: Backend — read routes (workload + inbox)

> **STATUS: ✅ DONE (commit `295356a`).** NEW `auth-worker/src/services/assignments.ts` (`getOrgAssignmentWorkload` + `getMyAssignments`); `cells_done` derived on read = `JOIN assignment_cells→cells ON (file_id, cell_id) WHERE side='target' AND validated=1`. Routes: `GET /api/v2/orgs/:orgId/assignments/workload` (maintainer+) on orgs.ts; `GET /api/v2/projects/:projectId/assignments/mine` (any member via `resolveProjectRole`) on projects.ts. real-D1 tests `assignment-reads.test.ts`. **auth-worker 84/84 pass.** Worktree gotcha: no `auth-worker/node_modules` → symlinked to main repo's (gitignored, same base commit).

**Files:** new `auth-worker/src/services/assignments.ts`; modify `auth-worker/src/routes/orgs.ts` + `projects.ts`; test `auth-worker/src/__tests__/assignment-reads.test.ts`.

Reads live on auth-worker (org-context, same D1). Progress derived on read.

- [ ] **Workload** (manager): `GET /api/v2/orgs/:orgId/assignments/workload` (org maintainer+) → per assignee in the org: open-assignment count, `cells_total` sum, `cells_done` = count of `assignment_cells` whose `cells` row is validated (`JOIN cells c ON c.file_id=ac.file_id AND c.cell_id=ac.cell_id AND c.side='target' AND c.validated=1`), filtered `unassigned_at IS NULL`.
- [ ] **Inbox** (assignee): `GET /api/v2/projects/:projectId/assignments/mine` (any member) → caller's open assignments (`assignee_user_id = caller`, `unassigned_at IS NULL`, `completed_at IS NULL`): `scopeLabel`, deadline, `cells_total`, derived `cells_done`.
- [ ] **Tests** (real-D1): seed assignments + assignment_cells + a validated cell → assert workload aggregates + inbox rows + role gates. **Commit.**

---

### Task AS3: Client — assign action + workload rollup

**Files:** new `src/lib/sync/assignments.ts`; modify `src/components/org/ProjectOverview.tsx`, `src/components/org/OrgHome.tsx` (+ tests).

- [ ] **assignments.ts**: `getWorkload(jwt, orgId)`, `getMyAssignments(jwt, projectId)`, and `createAssignment(...)`. **INVESTIGATE FIRST:** how the client emits a project-level event — reuse the comment-emit path (the outbox / a direct `POST /events` to sync-worker with a sync token, like comment.create) rather than inventing one. The assign action emits one `assignment.create` RawEvent `{kind, projectId, author, payload, id, schemaVersion, clientTs}`.
- [ ] **ProjectOverview**: a maintainer/project_lead **"Assign…"** affordance — pick a member (org members), pick a book (project file) or chapter, optional deadline → `createAssignment`. (Book scope first; chapter if the file's chapter list is readily available.)
- [ ] **OrgHome**: a **per-member workload** rollup (from `getWorkload`) — each member's open assignments + progress %.
- [ ] **Tests** (RTL): assign action emits the event; workload rollup renders. `tsc -b`. **Commit.**

---

### Task AS4: Client — "Assigned to me" inbox

**Files:** new `src/components/org/AssignedToMe.tsx` + route in `src/App.tsx` + sidebar link; test.

- [ ] An **"Assigned to me"** surface listing the caller's open assignments (`getMyAssignments`) — scope label, deadline, progress (`cells_done / cells_total`), link to the project. RTL test. **Commit.**

---

## Self-Review
- Spec coverage: project_lead-gated assign ✓; one event per scope ✓ (`assignment.create` resolves N cells server-side); book/chapter scope ✓ (cells/verses deferred); manager workload + assignee inbox ✓; reassign/unassign ✓; progress derived on-read (no commit-path hook) ✓.
- Collision: only `types.ts`/`role-policy.ts`/`dispatch.ts` are shared with the user's active core — additions are append-style (new union members + a new switch case + a new handler file), low conflict risk; re-merge their main at each landing.
- Deferred (documented): `.complete` server-emit + per-commit clearing, gutter avatars, full Members Matrix, cells/verses scope.
- Open investigation (AS3): the client project-level event-emission path (reuse comment.create's).
