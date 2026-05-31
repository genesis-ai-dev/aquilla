# Project Archive / Untrack (org-context) — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Let an org owner **untrack a completed project** from the manager/owner Overview — archive it (drops from the rollup + Projects list automatically) and see/restore it from an **Archived** view. Randall's explicit PM-portal ask: "archive some projects and not track."

**Architecture:** The archive primitives already exist end-to-end — `POST/DELETE /api/v2/projects/:projectId/archive` (owner-only) on the backend, `archiveProjectRemote`/`unarchiveProjectRemote` client wrappers, and the portfolio + projects-list queries already exclude `archived_at IS NOT NULL`. So archiving a project *already* untracks it from the Overview. The only gaps are (1) no way to **list** archived projects (both list endpoints hard-exclude them), and (2) no archive/restore affordance in the **org-context** UI. This slice adds a `?archived` filter to the existing list endpoint and wires the org-context Archive button + Archived view. No new tables, no new endpoints.

**Tech Stack:** Hono + D1 (real-D1 vitest-pool-workers harness); React + RTL + react-router v7. Reuses the existing archive endpoints/wrappers and the Phase 1/2 org shell.

**Design source:** committed spec [docs/superpowers/specs/2026-05-30-org-context-navigation-design.md](../specs/2026-05-30-org-context-navigation-design.md) (Phase 2). **Out of scope (YAGNI):** bulk archive, archive-from-Overview-row (deliberate one-at-a-time via the project page is safer), per-file archive, retention/purge.

---

### Task AU1: Backend — `?archived` filter on `GET /api/v2/projects`

**Files:** modify `auth-worker/src/routes/projects.ts`; test `auth-worker/src/__tests__/projects-archived-filter.test.ts`.

The list route (line ~198) builds one AD-12 max-wins query with a hard `WHERE p.archived_at IS NULL` (line ~256). Parametrize that single clause from a `?archived` query param and add `p.archived_at` to the SELECT + response. The clause is a fixed string (no user data) so string interpolation is injection-safe; the positional binds are unchanged.

- [ ] **Step 1: failing test** — `auth-worker/src/__tests__/projects-archived-filter.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("GET /api/v2/projects?archived", () => {
  async function seed() {
    await seedUser(1, "wendi")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('live', 'Live', 1, 1)").run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at, archived_by) VALUES ('old', 'Old', 1, 1, CURRENT_TIMESTAMP, 1)",
    ).run()
  }

  it("default list excludes archived projects", async () => {
    await seed()
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    expect(body.projects.map((p) => p.id)).toEqual(["live"])
  })

  it("archived=true returns only archived projects, with archivedAt", async () => {
    await seed()
    const res = await app.request("/api/v2/projects?orgId=1&archived=true", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; archivedAt: string | null }> }
    expect(body.projects.map((p) => p.id)).toEqual(["old"])
    expect(body.projects[0].archivedAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/projects-archived-filter.test.ts`.

- [ ] **Step 3: implement** in `auth-worker/src/routes/projects.ts`, inside the `projects.get("/", …)` handler:

  - After the existing `orgFilter` parse (line ~202), add:

```ts
  const archivedParam = c.req.query("archived")
  const wantArchived = archivedParam === "true" || archivedParam === "1"
  const archivedClause = wantArchived ? "p.archived_at IS NOT NULL" : "p.archived_at IS NULL"
```

  - In the SELECT column list (line ~220) add `p.archived_at` — change `SELECT p.id, p.name, p.org_id,` to:

```ts
    `SELECT p.id, p.name, p.org_id, p.archived_at,
```

  - Replace the hard-coded `WHERE p.archived_at IS NULL` (line ~256) with the interpolated clause:

```ts
      WHERE ${archivedClause}
```

  - Add `archived_at` to the `.all<…>()` row type (after `org_id: number | null`):

```ts
      archived_at: string | null
```

  - In the response `.map((row) => ({ … }))` (line ~284) add `archivedAt`:

```ts
      id: row.id,
      name: row.name,
      orgId: row.org_id,
      archivedAt: row.archived_at,
      role: {
```

- [ ] **Step 4: run PASS** (both cases) + full worker suite — `cd auth-worker && npx vitest run`.
- [ ] **Step 5: commit** — `git add auth-worker/src/routes/projects.ts auth-worker/src/__tests__/projects-archived-filter.test.ts && git commit -m "feat(auth-worker): ?archived filter on projects list (untrack support)"`

---

### Task AU2: Client — archive/restore affordances + Archived view

**Files:** modify `src/lib/sync/cloud-projects.ts`, `src/components/org/ProjectOverview.tsx`, `src/components/org/OrgSidebar.tsx`, `src/App.tsx`; create `src/components/org/ArchivedProjects.tsx`; tests `src/components/org/ProjectOverview.test.tsx`, `src/components/org/ArchivedProjects.test.tsx`.

- [ ] **Step 1: list wrapper** — add to `src/lib/sync/cloud-projects.ts` (after `fetchAccessibleProjects`):

```ts
/**
 * GET /api/v2/projects?orgId=N&archived=true — archived (untracked) projects in
 * an org. Same access rules as the live list; returns [] on any error.
 */
export async function fetchArchivedProjects(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CloudProjectSummary[]> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/projects?orgId=${orgId}&archived=true`, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { projects?: CloudProjectSummary[] }
    return body.projects ?? []
  } catch {
    return []
  }
}
```

- [ ] **Step 2: ProjectOverview archive/restore** — rewrite `src/components/org/ProjectOverview.tsx`. Owner gate = `project.syncRole?.level >= 700`; archived state = `project.deletedAt` present (minimalProjectRecord maps server `archivedAt` → `deletedAt`). Use `archiveProjectRemote`/`unarchiveProjectRemote` + `refresh()`:

```tsx
import { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { archiveProjectRemote, unarchiveProjectRemote } from "@/lib/sync/archive"

export function ProjectOverview() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { project, status, refresh } = useProject(id)
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOwner = (project?.syncRole?.level ?? 0) >= 700
  const isArchived = Boolean(project?.deletedAt)

  async function handleArchive() {
    if (!jwt) return
    setBusy(true); setError(null)
    const res = await archiveProjectRemote(id, jwt)
    setBusy(false)
    if (res.kind === "archived" || res.kind === "local-only") {
      navigate("/projects")
    } else if (res.kind === "forbidden") {
      setError(res.message ?? "Only owners can archive a project.")
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  async function handleRestore() {
    if (!jwt) return
    setBusy(true); setError(null)
    const res = await unarchiveProjectRemote(id, jwt)
    setBusy(false)
    if (res.kind === "restored" || res.kind === "local-only") {
      await refresh()
    } else if (res.kind === "forbidden") {
      setError(res.message ?? "Only owners can restore a project.")
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={project?.name ?? "Project"} />}
      statusBar={null}
      main={
        <div className="p-6">
          {status !== "ready" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="max-w-xl rounded-lg border p-6">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{project?.name}</h1>
                {isArchived && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Archived</span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => navigate(`/project/${id}`)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                >
                  Open project
                </button>
                {isOwner && !isArchived && (
                  <button
                    onClick={handleArchive}
                    disabled={busy}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                  >
                    Archive
                  </button>
                )}
                {isOwner && isArchived && (
                  <button
                    onClick={handleRestore}
                    disabled={busy}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40 disabled:opacity-50"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      }
    />
  )
}
```

- [ ] **Step 3: ArchivedProjects view** — create `src/components/org/ArchivedProjects.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchArchivedProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { unarchiveProjectRemote } from "@/lib/sync/archive"

export function ArchivedProjects() {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!jwt || activeOrgId == null) return
    setLoading(true)
    fetchArchivedProjects(jwt, activeOrgId)
      .then(setProjects)
      .finally(() => setLoading(false))
  }, [jwt, activeOrgId])

  useEffect(() => { load() }, [load])

  async function handleRestore(id: string) {
    if (!jwt) return
    setError(null)
    const res = await unarchiveProjectRemote(id, jwt)
    if (res.kind === "restored" || res.kind === "local-only") {
      load()
    } else if (res.kind === "forbidden") {
      setError(res.message ?? "Only owners can restore a project.")
    } else if (res.kind === "error") {
      setError(res.message)
    }
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Archived" />}
      statusBar={null}
      main={
        <div className="p-6 space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No archived projects.</p>
          ) : (
            <div className="rounded-lg border divide-y">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-4 p-4">
                  <span className="font-medium">{p.name}</span>
                  <button
                    onClick={() => handleRestore(p.id)}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />
  )
}
```

- [ ] **Step 4: route + sidebar link.**
  - In `src/App.tsx`: import `ArchivedProjects` and add the route **before** `/projects/:id` (static beats dynamic, but declare it first to be explicit):

```tsx
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
// …
      <Route path="/projects" element={<ProjectsList />} />
      <Route path="/projects/archived" element={<ArchivedProjects />} />
      <Route path="/projects/:id" element={<ProjectOverview />} />
```

  - In `src/components/org/OrgSidebar.tsx`, add an admin-gated link under the existing `isAdmin` block (archived is a management surface; restore enforces owner server-side):

```tsx
        {isAdmin && <>
          <div className="my-1 border-t" />
          <NavLink to="/members" className={link}>Members</NavLink>
          <NavLink to="/projects/archived" className={link}>Archived</NavLink>
          <NavLink to="/settings" className={link}>Settings</NavLink>
        </>}
```

- [ ] **Step 5: tests.**
  - `src/components/org/ProjectOverview.test.tsx`: mock `@/hooks/useProject`, `@/hooks/useFrontierSession`, `@/lib/sync/archive`, and `react-router-dom` (`useParams`→`{id:"p1"}`, `useNavigate`→spy). (a) owner + not archived → "Archive" button present; click → `archiveProjectRemote("p1", jwt)` called + navigate("/projects"). (b) non-owner (level 100) → no "Archive" button. (c) archived (`deletedAt` set) + owner → "Restore" button + "Archived" badge; click → `unarchiveProjectRemote` called.
  - `src/components/org/ArchivedProjects.test.tsx`: mock `@/context/OrgContext` (`activeOrgId: 1`), `@/hooks/useFrontierSession` (jwt), `@/lib/sync/cloud-projects` (`fetchArchivedProjects`→`[{id:"old",name:"Old",role:{…}}]`), `@/lib/sync/archive` (`unarchiveProjectRemote`→`{kind:"restored"}`). Assert "Old" + "Restore" render; click Restore → `unarchiveProjectRemote("old", jwt)` called.

- [ ] **Step 6: run** — `npx vitest run src/components/org/ProjectOverview.test.tsx src/components/org/ArchivedProjects.test.tsx` + `npx tsc -b`.
- [ ] **Step 7: commit** — `git add src/lib/sync/cloud-projects.ts src/components/org/ProjectOverview.tsx src/components/org/ArchivedProjects.tsx src/components/org/OrgSidebar.tsx src/App.tsx src/components/org/ProjectOverview.test.tsx src/components/org/ArchivedProjects.test.tsx && git commit -m "feat(client): org-context archive/untrack + Archived view"`

---

## Self-Review
- Spec/persona coverage: owner can untrack a completed project (Archive on the project page → drops from Overview rollup + Projects list, both already exclude archived ✓); owner can review + restore from an Archived view ✓; `?archived` is the only backend addition (no new endpoint/table — reuses existing archive primitives) ✓.
- Types: `fetchArchivedProjects` returns `CloudProjectSummary[]` (already has optional `archivedAt`); server adds `archivedAt` to list rows; `ArchiveResult`/`UnarchiveResult` kinds (`archived`/`restored`/`local-only`/`forbidden`/`error`) handled exhaustively in both components.
- Placeholders: none. Route order (`/projects/archived` before `/projects/:id`) + owner gate (700) vs admin-visible Archived link (≥600, restore 403s gracefully for non-owners) flagged for the implementer.
