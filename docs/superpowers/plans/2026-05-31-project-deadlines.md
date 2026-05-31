# Project Deadlines + Overdue Flags — Implementation Plan (org-manager-polish #3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Let a manager (maintainer+) set a **deadline** on a project and see **overdue / due-soon** flags on the distilled Overview — the director-of-projects "are we on track?" need.

**Architecture:** One nullable `deadline_at` column on `projects` (migration 0019). A maintainer-gated `PATCH /api/v2/projects/:projectId/deadline`. The portfolio rollup (`getOrgPortfolio`) already feeds the Overview *and* the org-context ProjectOverview, so adding `deadlineAt` there surfaces it in both places with no extra endpoint. The client computes overdue/soon from the date + now, badges each Overview row, counts overdue in the rollup, and folds "overdue" into the attention ranking. The ProjectOverview page gets a maintainer-gated date setter.

**Tech Stack:** Hono + D1 (real-D1 vitest-pool-workers; `readD1Migrations` auto-applies new migrations); React + RTL.

**Out of scope (YAGNI):** per-assignment/per-cell deadlines (Q29 mentions both — project-level is the manager-facing 80%), reminders/notifications, recurring deadlines.

---

### Task PD1: Backend — deadline column + endpoint + portfolio field

**Files:** create `auth-worker/migrations/0019_project_deadline.sql`; modify `auth-worker/src/routes/projects.ts`, `auth-worker/src/services/org-permissions.ts`; test `auth-worker/src/__tests__/project-deadline.test.ts`.

- [ ] **Step 1: migration** — `auth-worker/migrations/0019_project_deadline.sql`:

```sql
-- 0019_project_deadline.sql
-- Optional per-project target date for manager oversight (overdue/at-risk flags
-- on the org Overview). Nullable; set/cleared by maintainer+ via
-- PATCH /api/v2/projects/:projectId/deadline. Stored as an ISO date string.
ALTER TABLE projects ADD COLUMN deadline_at DATETIME;
```

- [ ] **Step 2: failing test** — `auth-worker/src/__tests__/project-deadline.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seed() {
  await seedUser(1, "wendi"); await seedUser(2, "anna")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 300, 1)").run() // anna: reviewer (sub-maintainer)
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
}

describe("PATCH /api/v2/projects/:projectId/deadline", () => {
  it("sets a deadline for a maintainer+ caller and clears it with null", async () => {
    await seed()
    const set = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ deadline: "2026-07-01" }) }, env)
    expect(set.status).toBe(200)
    let row = await env.AQUILLA_DB.prepare("SELECT deadline_at FROM projects WHERE id='pa'").first<{ deadline_at: string | null }>()
    expect(row?.deadline_at).toBe("2026-07-01")
    const clear = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ deadline: null }) }, env)
    expect(clear.status).toBe(200)
    row = await env.AQUILLA_DB.prepare("SELECT deadline_at FROM projects WHERE id='pa'").first<{ deadline_at: string | null }>()
    expect(row?.deadline_at).toBeNull()
  })

  it("403s a sub-maintainer caller", async () => {
    await seed()
    const res = await app.request("/api/v2/projects/pa/deadline", { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify({ deadline: "2026-07-01" }) }, env)
    expect(res.status).toBe(403)
  })

  it("includes deadlineAt in the org portfolio", async () => {
    await seed()
    await env.AQUILLA_DB.prepare("UPDATE projects SET deadline_at = '2026-07-01' WHERE id='pa'").run()
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; deadlineAt: string | null }> }
    expect(body.projects.find((p) => p.id === "pa")?.deadlineAt).toBe("2026-07-01")
  })
})
```

- [ ] **Step 3: run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/project-deadline.test.ts`.

- [ ] **Step 4: route** in `projects.ts` (zValidator/z already imported; `resolveProjectRole`, `ROLE` imported). Add near the archive routes:

```ts
const deadlineBody = z.object({ deadline: z.string().min(1).max(40).nullable() })
projects.patch("/:projectId/deadline", authMiddleware, zValidator("json", deadlineBody), async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < ROLE.MAINTAINER) return c.json({ error: "maintainer+ required" }, 403)
  const { deadline } = c.req.valid("json")
  await c.env.AQUILLA_DB.prepare(
    "UPDATE projects SET deadline_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(deadline, projectId).run()
  return c.json({ ok: true, deadlineAt: deadline })
})
```

- [ ] **Step 5: portfolio field** in `org-permissions.ts` `getOrgPortfolio` — add `p.deadline_at` to the SELECT, `deadlineAt: string | null` to `PortfolioRow`, the row type, and the mapping:

```ts
// PortfolioRow: add `deadlineAt: string | null`
// SELECT: add `p.deadline_at AS deadline_at,` (after p.name)
// row generic: add `deadline_at: string | null`
// map: add `deadlineAt: r.deadline_at,`
```

- [ ] **Step 6: run PASS** (all 3) + full worker suite — `cd auth-worker && npx vitest run`.
- [ ] **Step 7: commit** — `git add auth-worker/migrations/0019_project_deadline.sql auth-worker/src/routes/projects.ts auth-worker/src/services/org-permissions.ts auth-worker/src/__tests__/project-deadline.test.ts && git commit -m "feat(auth-worker): per-project deadline (column + maintainer PATCH + portfolio field)"`

---

### Task PD2: Client — deadline badges on Overview + setter on ProjectOverview

**Files:** modify `src/lib/frontier/portfolio.ts` (+ test), `src/components/org/OrgHome.tsx` (+ test), `src/components/org/ProjectOverview.tsx`, `src/lib/sync/cloud-projects.ts` or a deadline wrapper.

- [ ] **Step 1: portfolio helpers** — in `src/lib/frontier/portfolio.ts`, add `deadlineAt: string | null` to `PortfolioProject`, and:

```ts
export type DeadlineStatus = "overdue" | "soon" | "ok"
/** null when no deadline; "overdue" past due; "soon" within 7 days; else "ok". */
export function deadlineStatus(p: PortfolioProject, now: number): DeadlineStatus | null {
  if (!p.deadlineAt) return null
  const t = Date.parse(p.deadlineAt)
  if (Number.isNaN(t)) return null
  if (t < now) return "overdue"
  if (t - now <= 7 * 24 * 60 * 60 * 1000) return "soon"
  return "ok"
}
```

In `attentionRank`, add an overdue bonus so overdue projects rank to the top (above stalled). Change the return to:

```ts
export function attentionRank(p: PortfolioProject, now: number): number {
  const ageMs = p.lastEditAt != null ? now - p.lastEditAt : Infinity
  const stale = ageMs > 14 * 24 * 60 * 60 * 1000 ? 1 : 0
  const overdue = deadlineStatus(p, now) === "overdue" ? 1 : 0
  return overdue * 2000 + stale * 1000 + (1 - validatedPct(p)) * 100
}
```

Test (`portfolio.test.ts`): add `deadlineAt` to fixtures; unit-test `deadlineStatus` (past → "overdue", +3d → "soon", +30d → "ok", null → null) and that an overdue project out-ranks a merely-stalled one.

- [ ] **Step 2: Overview** — in `src/components/org/OrgHome.tsx`: import `deadlineStatus`; compute `overdueCount = projects.filter(p => deadlineStatus(p, now) === "overdue").length`; add an **"Overdue"** rollup card (grid becomes `grid-cols-5`); in each ranked row, render a deadline badge when status is non-null/non-ok: `overdue` → red "Overdue", `soon` → amber "Due soon" (with the date). Test (`OrgHome.test.tsx`): add `deadlineAt` to the mock fixtures (one overdue), assert the "Overdue" card + an "Overdue" badge render.

- [ ] **Step 3: setter** — add a client wrapper (in `src/lib/sync/cloud-projects.ts`, near `archiveProjectRemote`'s neighbors, or a new `setProjectDeadline` in `src/lib/frontier/...`):

```ts
export async function setProjectDeadline(jwt: string, projectId: string, deadline: string | null, apiUrl: string = FRONTIER_API_URL): Promise<void> {
  const res = await fetch(`${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/deadline`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ deadline }),
  })
  if (!res.ok) throw new Error(`setProjectDeadline failed: HTTP ${res.status}`)
}
```

In `src/components/org/ProjectOverview.tsx` (which already fetches its portfolio row `audio` for the audio line — reuse it for the current `deadlineAt`): when `(project.syncRole.level ?? 0) >= 600`, render a small deadline control — an `<input type="date">` seeded from `audio?.deadlineAt` + a **Set** button (calls `setProjectDeadline(jwt, id, value)` then refetches the portfolio row) and a **Clear** button (`setProjectDeadline(jwt, id, null)`). Show the current deadline + overdue state when present.

- [ ] **Step 4:** `npx vitest run src/lib/frontier/portfolio.test.ts src/components/org/OrgHome.test.tsx src/components/org/ProjectOverview.test.tsx` + `npx tsc -b`.
- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(client): project deadlines — Overview overdue badges/rollup + maintainer setter"`

---

## Self-Review
- Coverage: maintainer+ set/clear deadline ✓; Overview overdue/soon badges + overdue rollup + attention-rank bonus ✓; reuses the portfolio feed (no extra endpoint) ✓; migration auto-applies in tests ✓.
- Types: `PortfolioRow`(server)/`PortfolioProject`(client) both gain `deadlineAt: string | null`; `deadlineStatus` consumed by OrgHome + attentionRank.
- Gate: `resolveProjectRole` + `ROLE.MAINTAINER` mirrors the existing archive route's owner gate (one rung lower).
- Placeholders: none. The ProjectOverview deadline setter reuses the existing `getPortfolio` row fetch (added in the audio slice) for the current value; confirm that fetch is present before wiring.
