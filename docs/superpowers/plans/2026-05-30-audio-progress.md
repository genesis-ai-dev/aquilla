# Audio Progress (Overview + project views) — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Show **audio progress** to managers/owners — per project, the share of cells that have audio and total recorded minutes — surfaced in the distilled Overview (rollup + per-project rows) and on the project view. Randall's PM-portal ask: "ability to see audio progress."

**Architecture:** Derive-on-read from the existing `cell_audio` table (auth-worker migration 0014, same `AQUILLA_DB` the portfolio already queries). Extend the single portfolio query with two correlated subqueries — `audioCells` = `COUNT(DISTINCT cell_id)` over live (`deleted = 0`) attachments, `recordedMs` = `SUM(duration_ms)` over live **selected** (`selected = 1`) clips. No new table, no new endpoint for the Overview (the `/portfolio` route already returns whatever `getOrgPortfolio` produces). The client adds `audioPct`/`recordedMinutes` helpers and renders them in the Overview; the project view reuses `getPortfolio` to show its own row's audio.

**Tech Stack:** Hono + D1 (real-D1 vitest-pool-workers); React + RTL. Reuses the Phase 2 Overview (`OrgHome`) + portfolio lib.

**Design source:** committed spec [docs/superpowers/specs/2026-05-30-org-context-navigation-design.md](../specs/2026-05-30-org-context-navigation-design.md) (Phase 2 Overview — audio was the explicitly-deferred metric). **Out of scope (YAGNI):** per-slot breakdown (recording vs generatedVoice — `audioCells` counts any live clip), per-file audio drill-down, audio velocity/projected-finish, threading audio through the single-project hydration path (the project view reuses the org portfolio instead of a new endpoint).

`cell_audio` columns used: `project_id, cell_id, duration_ms, selected (1=active in slot), deleted (1=tombstone)`. PK `(project_id, file_id, cell_id, audio_id)`.

---

### Task AA1: Backend — portfolio audio aggregation

**Files:** modify `auth-worker/src/services/org-permissions.ts`; test `auth-worker/src/__tests__/org-portfolio.test.ts` (extend).

- [ ] **Step 1: failing test** — append to `auth-worker/src/__tests__/org-portfolio.test.ts` inside the existing `describe`:

```ts
  it("includes per-project audio progress (distinct live cells + selected recorded ms)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000), ('f3', 'pb', 'MRK', 'e3', 50, 50, 500)").run()
    // pa: c1+c2 selected recordings (90000ms); c3 unselected (counts as a cell w/ audio, not recorded ms); c4 deleted (excluded)
    await env.AQUILLA_DB.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, event_id, created_ts) VALUES
        ('pa','f1','c1','a1','recording','frontier-audio://a1.wav',60000,1,0,'ae1',1),
        ('pa','f1','c2','a2','recording','frontier-audio://a2.wav',30000,1,0,'ae2',1),
        ('pa','f1','c3','a3','recording','frontier-audio://a3.wav',99999,0,0,'ae3',1),
        ('pa','f1','c4','a4','recording','frontier-audio://a4.wav',99999,1,1,'ae4',1)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; audioCells: number; recordedMs: number }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    expect(byId.pa).toMatchObject({ audioCells: 3, recordedMs: 90000 })
    expect(byId.pb).toMatchObject({ audioCells: 0, recordedMs: 0 })
  })
```

- [ ] **Step 2: run, verify fail** — `cd auth-worker && npx vitest run src/__tests__/org-portfolio.test.ts`.

- [ ] **Step 3: implement** in `auth-worker/src/services/org-permissions.ts`:

  - Extend the interface (line 571):

```ts
export interface PortfolioRow { id: string; name: string; totalCells: number; validatedCells: number; lastEditAt: number | null; audioCells: number; recordedMs: number }
```

  - Replace the `getOrgPortfolio` query + mapping (lines 574-587) with:

```ts
export async function getOrgPortfolio(env: Env, orgId: number): Promise<PortfolioRow[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT p.id AS id, p.name AS name,
            COALESCE(SUM(f.cell_count), 0)     AS total_cells,
            COALESCE(SUM(f.approved_count), 0) AS validated_cells,
            MAX(f.last_edit_at)                AS last_edit_at,
            (SELECT COUNT(DISTINCT ca.cell_id) FROM cell_audio ca
              WHERE ca.project_id = p.id AND ca.deleted = 0)                       AS audio_cells,
            (SELECT COALESCE(SUM(ca.duration_ms), 0) FROM cell_audio ca
              WHERE ca.project_id = p.id AND ca.deleted = 0 AND ca.selected = 1)    AS recorded_ms
       FROM projects p
       LEFT JOIN files f ON f.project_id = p.id
      WHERE p.org_id = ? AND p.archived_at IS NULL
      GROUP BY p.id, p.name
      ORDER BY p.name COLLATE NOCASE`,
  ).bind(orgId).all<{ id: string; name: string; total_cells: number; validated_cells: number; last_edit_at: number | null; audio_cells: number; recorded_ms: number }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    totalCells: r.total_cells,
    validatedCells: r.validated_cells,
    lastEditAt: r.last_edit_at,
    audioCells: r.audio_cells,
    recordedMs: r.recorded_ms,
  }))
}
```

  (The `/portfolio` route in `orgs.ts` returns `{ projects }` directly, so the new fields flow through with no route change.)

- [ ] **Step 4: run PASS** + full worker suite — `cd auth-worker && npx vitest run`.
- [ ] **Step 5: commit** — `git add auth-worker/src/services/org-permissions.ts auth-worker/src/__tests__/org-portfolio.test.ts && git commit -m "feat(auth-worker): per-project audio progress in portfolio rollup"`

---

### Task AA2: Client — audio progress in Overview + project view

**Files:** modify `src/lib/frontier/portfolio.ts`, `src/components/org/OrgHome.tsx`, `src/components/org/ProjectOverview.tsx`; tests `src/lib/frontier/portfolio.test.ts`, `src/components/org/OrgHome.test.tsx` (extend).

- [ ] **Step 1: portfolio lib** — in `src/lib/frontier/portfolio.ts`, extend the interface + add helpers:

```ts
export interface PortfolioProject {
  id: string
  name: string
  totalCells: number
  validatedCells: number
  lastEditAt: number | null
  audioCells: number
  recordedMs: number
}
```

  Add after `validatedPct`:

```ts
/** fraction of cells that have audio, 0..1 (0 when no cells). */
export function audioPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.audioCells / p.totalCells : 0
}

/** total recorded minutes (selected live clips), rounded. */
export function recordedMinutes(p: PortfolioProject): number {
  return Math.round(p.recordedMs / 60000)
}
```

- [ ] **Step 2: Overview** — in `src/components/org/OrgHome.tsx`:
  - Import `audioPct, recordedMinutes` alongside the existing portfolio imports.
  - Compute rollup audio after `stalledCount`:

```tsx
  const avgAudioPct =
    projects.length > 0 ? projects.reduce((s, p) => s + audioPct(p), 0) / projects.length : 0
  const totalRecordedMin = projects.reduce((s, p) => s + recordedMinutes(p), 0)
```

  - Change the rollup strip from `grid-cols-3` to `grid-cols-4` and add an audio card (after the Stalled card):

```tsx
              <div className="grid grid-cols-4 gap-4">
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{projects.length}</p>
                  <p className="text-sm text-muted-foreground">Projects</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{Math.round(avgValidatedPct * 100)}%</p>
                  <p className="text-sm text-muted-foreground">Avg validated</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{Math.round(avgAudioPct * 100)}%</p>
                  <p className="text-sm text-muted-foreground">Avg audio</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold">{stalledCount}</p>
                  <p className="text-sm text-muted-foreground">Stalled</p>
                </div>
              </div>
```

  - In the attention-ranked row, add an audio % line under the validated bar. Inside the `ranked.map`, compute `const apct = Math.round(audioPct(p) * 100)` next to `pct`, and add to the right-hand column (after the stalled/validated line):

```tsx
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-medium">{pct}%</p>
                          <p className={`text-xs ${stalled ? "text-destructive" : "text-muted-foreground"}`}>
                            {stalled ? "Stalled" : `${pct}% validated`}
                          </p>
                          <p className="text-xs text-muted-foreground">{apct}% audio</p>
                        </div>
```

- [ ] **Step 3: project view** — in `src/components/org/ProjectOverview.tsx`, show this project's audio progress by reusing the org portfolio (graceful: no line if the row isn't in the active org's portfolio). Add imports + a small effect:

```tsx
import { useActiveOrg } from "@/context/OrgContext"
import { getPortfolio, audioPct, recordedMinutes, type PortfolioProject } from "@/lib/frontier/portfolio"
```

  Inside the component (after the existing hooks):

```tsx
  const { activeOrgId } = useActiveOrg()
  const [audio, setAudio] = useState<PortfolioProject | null>(null)
  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    getPortfolio(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setAudio(list.find((p) => p.id === id) ?? null) })
      .catch(() => { if (!cancelled) setAudio(null) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId, id])
```

  Render an audio line under the file count (only when `audio` is present and has cells):

```tsx
              <p className="mt-1 text-sm text-muted-foreground">{project?.files.length ?? 0} files</p>
              {audio && audio.totalCells > 0 && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {Math.round(audioPct(audio) * 100)}% of cells have audio · {recordedMinutes(audio)} min recorded
                </p>
              )}
```

  (`useState`/`useEffect` are already imported in ProjectOverview after the archive slice added `useState`; add `useEffect` to the React import.)

- [ ] **Step 4: tests.**
  - `src/lib/frontier/portfolio.test.ts` (extend): update existing `PortfolioProject` fixtures to include `audioCells`/`recordedMs`; add unit tests — `audioPct({totalCells:200,audioCells:50,…})` → 0.25; `audioPct({totalCells:0,…})` → 0; `recordedMinutes({recordedMs:90000})` → 2 (rounds 1.5→2); `recordedMinutes({recordedMs:0})` → 0.
  - `src/components/org/OrgHome.test.tsx` (extend): the `getPortfolio` mock fixtures already exist — add `audioCells`/`recordedMs` to them (e.g. stalled-1: `audioCells: 100, recordedMs: 120000` → 50% audio; fresh-1: `audioCells: 50, recordedMs: 60000`). Add an assertion that "Avg audio" renders and the computed percentage appears (e.g. `expect(screen.getByText("Avg audio")).toBeInTheDocument()`).

- [ ] **Step 5: run** — `npx vitest run src/lib/frontier/portfolio.test.ts src/components/org/OrgHome.test.tsx` + `npx tsc -b` (expect only the pre-existing unrelated `source-export.ts` erasableSyntaxOnly error, if still present — not from these files).
- [ ] **Step 6: commit** — `git add src/lib/frontier/portfolio.ts src/lib/frontier/portfolio.test.ts src/components/org/OrgHome.tsx src/components/org/OrgHome.test.tsx src/components/org/ProjectOverview.tsx && git commit -m "feat(client): audio progress in Overview + project view"`

---

## Self-Review
- Spec/persona coverage: Randall's "see audio progress" delivered — per-project audio % + recorded minutes in the Overview rollup and rows, plus the project view ✓; derive-on-read (correlated subqueries, no new table/endpoint) honors the materialized-vs-derived preference ✓; archived projects already excluded by the existing `WHERE` ✓.
- Types: `PortfolioRow` (server) and `PortfolioProject` (client) both gain `audioCells`/`recordedMs`; `audioPct`/`recordedMinutes` consumed by OrgHome + ProjectOverview.
- Metric correctness: `audioCells` counts DISTINCT live cells (a cell with recording+generatedVoice counts once); `recordedMs` sums only `selected = 1` live clips (avoids summing superseded takes). Per-slot split deferred.
- Placeholders: none. Project-view reuse of the org portfolio (vs a new single-project endpoint) is intentional and degrades gracefully when activeOrgId is null/mismatched.
