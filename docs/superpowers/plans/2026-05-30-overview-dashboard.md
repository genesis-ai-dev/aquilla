# Distilled Overview Dashboard — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Replace the org-context Overview placeholder with a distilled manager/owner dashboard: per-project progress (validated %) + last-activity, ranked by attention, with a portfolio rollup strip.

**Architecture:** One **derive-on-read** backend endpoint `GET /api/v2/orgs/:orgId/portfolio` that `GROUP BY`s the existing `files` aggregates (`cell_count`, `approved_count`, `last_edit_at`) over the org's non-archived projects (one query, no materialized table — matches the project's derived-over-materialized preference). The client `OrgHome` Overview fetches it, computes validated % + staleness, ranks attention (stalled/behind first), and renders a rollup + ranked list. Gated: org member (any role — Overview shows progress for projects you can access; an org member can access all org projects via the AD-12 org tier).

**Tech Stack:** Hono + D1 (real-D1 vitest-pool-workers harness); React + RTL. Reuses Phase 1 org-context shell + `useActiveOrg`.

**Design source:** committed spec [docs/superpowers/specs/2026-05-30-org-context-navigation-design.md](../specs/2026-05-30-org-context-navigation-design.md) (Phase 2 Overview). **Deferred (downstream):** audio % (needs `cell_audio` aggregation), true translated % (no per-file translated count today — only validated/approved), velocity + projected-finish (needs event-log time-series), archive-from-overview (pairs with the archive slice). This slice ships validated-% + last-activity attention ranking — the useful core — and iterates downstream.

---

### Task O1: Backend — `GET /api/v2/orgs/:orgId/portfolio`

**Files:** modify `auth-worker/src/services/org-permissions.ts`, `auth-worker/src/routes/orgs.ts`; test `auth-worker/src/__tests__/org-portfolio.test.ts`.

**Note:** Confirm the `files` table columns from the migrations (Explore found `project_id, cell_count, approved_count, last_edit_at`). Adjust column names in the query/seed if they differ.

- [ ] **Step 1: failing test** — `auth-worker/src/__tests__/org-portfolio.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("GET /api/v2/orgs/:orgId/portfolio", () => {
  it("returns per-project rollup (validated cells + last activity) for org projects", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)").run()
    // files carry the aggregates the portfolio sums
    await env.AQUILLA_DB.prepare("INSERT INTO files (id, project_id, name, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 100, 40, 1000), ('f2', 'pa', 'EXO', 100, 10, 2000), ('f3', 'pb', 'MRK', 50, 50, 500)").run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; name: string; totalCells: number; validatedCells: number; lastEditAt: number | null }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    expect(byId.pa).toMatchObject({ totalCells: 200, validatedCells: 50, lastEditAt: 2000 })
    expect(byId.pb).toMatchObject({ totalCells: 50, validatedCells: 50, lastEditAt: 500 })
  })

  it("excludes archived projects and 403s a non-org-member", async () => {
    await seedUser(1, "wendi"); await seedUser(9, "outsider")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('pz', 'Old', 1, 1, '2026-01-01')").run()
    const ok = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(((await ok.json()) as { projects: unknown[] }).projects).toHaveLength(0) // archived excluded
    const denied = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(denied.status).toBe(403)
  })
})
```

- [ ] **Step 2: run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/org-portfolio.test.ts`.

- [ ] **Step 3: service** in `org-permissions.ts`:

```ts
export interface PortfolioRow { id: string; name: string; totalCells: number; validatedCells: number; lastEditAt: number | null }

/** Per-project rollup over the org's non-archived projects (derive-on-read). */
export async function getOrgPortfolio(env: Env, orgId: number): Promise<PortfolioRow[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT p.id AS id, p.name AS name,
            COALESCE(SUM(f.cell_count), 0)     AS total_cells,
            COALESCE(SUM(f.approved_count), 0) AS validated_cells,
            MAX(f.last_edit_at)                AS last_edit_at
       FROM projects p
       LEFT JOIN files f ON f.project_id = p.id
      WHERE p.org_id = ? AND p.archived_at IS NULL
      GROUP BY p.id, p.name
      ORDER BY p.name COLLATE NOCASE`,
  ).bind(orgId).all<{ id: string; name: string; total_cells: number; validated_cells: number; last_edit_at: number | null }>()
  return (rows.results ?? []).map((r) => ({ id: r.id, name: r.name, totalCells: r.total_cells, validatedCells: r.validated_cells, lastEditAt: r.last_edit_at }))
}
```

- [ ] **Step 4: route** in `orgs.ts` (import `getOrgPortfolio`):

```ts
orgs.get("/:orgId/portfolio", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const projects = await getOrgPortfolio(c.env, orgId)
  return c.json({ projects })
})
```

- [ ] **Step 5: run PASS** (both cases) + full worker suite `cd auth-worker && npx vitest run`.
- [ ] **Step 6: commit** — `git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/org-portfolio.test.ts && git commit -m "feat(auth-worker): org portfolio rollup endpoint (derive-on-read)"`

---

### Task O2: Client — Overview dashboard

**Files:** create `src/lib/frontier/portfolio.ts` (+ test); modify `src/components/org/OrgHome.tsx` (+ test).

- [ ] **Step 1: portfolio lib + test** — `src/lib/frontier/portfolio.ts`:

```ts
import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"

export interface PortfolioProject { id: string; name: string; totalCells: number; validatedCells: number; lastEditAt: number | null }

export async function getPortfolio(jwt: string, orgId: number): Promise<PortfolioProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio`, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) throw new Error(`getPortfolio failed: HTTP ${res.status}`)
  return ((await res.json()) as { projects: PortfolioProject[] }).projects
}

/** validated fraction 0..1 (0 when no cells). */
export function validatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.validatedCells / p.totalCells : 0
}

/** Attention score: higher = more attention needed. Stalled (>14d / never) ranks above low completion. */
export function attentionRank(p: PortfolioProject, now: number): number {
  const ageMs = p.lastEditAt != null ? now - p.lastEditAt : Infinity
  const stale = ageMs > 14 * 24 * 60 * 60 * 1000 ? 1 : 0
  return stale * 1000 + (1 - validatedPct(p)) * 100 // stalled first, then least-validated
}
```

Test `src/lib/frontier/portfolio.test.ts`: mock fetch for `getPortfolio` (asserts URL + parse); unit-test `validatedPct` (50/200 → 0.25; 0 cells → 0) and `attentionRank` (stalled project ranks above a fresh low-completion one).

- [ ] **Step 2: Overview UI** — in `src/components/org/OrgHome.tsx`, replace the "Portfolio insights coming soon" placeholder (keep the AppShell + OrgSidebar + OrgBreadcrumb frame) with: on mount, `getPortfolio(jwt, activeOrgId)` into state; render a **rollup strip** (project count · avg validated % · # stalled) and an **attention-ranked list** (sort by `attentionRank(p, Date.now())` desc) where each row shows name, a validated-% bar, "stalled Nd" or "last active …" and links to `/projects/:id`. Empty state when no projects. Test `OrgHome.test.tsx` (extend): mock `getPortfolio` → assert the rollup + that the most-attention project sorts first.

- [ ] **Step 3:** `npx vitest run src/lib/frontier/portfolio.test.ts src/components/org/OrgHome.test.tsx` + `npx tsc -b`.
- [ ] **Step 4: commit** — `git add src/lib/frontier/portfolio.ts src/lib/frontier/portfolio.test.ts src/components/org/OrgHome.tsx src/components/org/OrgHome.test.tsx && git commit -m "feat(client): distilled Overview dashboard (validated %, attention ranking)"`

---

## Self-Review
- Spec coverage: portfolio rollup + attention ranking (the useful core) ✓; audio/translated-%/velocity/archive explicitly deferred with rationale ✓; derive-on-read (one GROUP BY) honors the materialized-vs-derived preference ✓; org-member gate ✓; archived excluded ✓.
- Types: `PortfolioRow`(server)/`PortfolioProject`(client) share fields; `getOrgPortfolio`/`getPortfolio`/`validatedPct`/`attentionRank` consumed by their tasks.
- Placeholders: none — confirm `files` column names against the migration before coding (flagged in O1).
