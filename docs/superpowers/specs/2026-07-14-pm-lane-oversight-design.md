# PM lane oversight — dashboard-first exposure of the lane model — Design

**Status:** Proposal for discussion · 2026-07-14 (follows AQU-538 slices 1–5)
**Driver:** Ryder — "the PM side needs to be conceptualized as an obvious dashboard overview
that makes it transparent what is going on. You also need to be able to add languages and
manage users from the org dashboard, not only under /project/:id."
**Builds on:** `2026-07-11-project-data-model-decision.md` (lanes), migrations 0054–0056,
`OrgHome` portfolio table, `ProjectOverview`, the (currently unmounted) `MembersMatrixView`.

---

## 1. The PM's mental model

A PM does not think in projects; they think in **project × language**: *"Where is Spanish on
the Gospels project? Who's on it? What's stalled?"* The lane model finally makes that a real
database dimension — this design makes it the PM's visible unit everywhere they already look:

| Altitude | Surface (exists today) | What it must answer per lane |
| --- | --- | --- |
| Org | `OrgHome` (`/`) portfolio table | which languages, how far along, what's stalled |
| Project | `ProjectOverview` (`/projects/:id`) | per-lane progress + people + quick actions |
| People | `/members` (+ dark `MembersMatrixView`) | who works which lanes, one-gesture staffing |

Guiding rule: **every PM gesture available under `/project/:id` must have a dashboard-level
equivalent** — add a language, see progress, staff a lane — without entering the workspace.

## 2. What exists to build on (recon summary)

- `GET /api/v2/orgs/:id/portfolio` → `PortfolioProject` counts (translated/validated/audio,
  deadline) — **no lane dimension** (src/lib/frontier/portfolio.ts).
- `GET .../files/:fileId/progress` **is already lane-aware** (`?lane=`, lane-suffixed ETags) —
  but the client (`src/lib/progress/file-progress-resource.ts`) never passes a lane.
- `MembersMatrixView` (members × projects role grid, batched `fetchOrgMembersMatrix`,
  per-project role editing) is built + tested and **mounted on no route**.
- Assignments (`assignment.create`, scope books/chapters, AssignModal, WorkloadRollup,
  `/assigned`) have **no lane dimension**.
- Lane registry = `settings.targetLanes` (PATCH project settings, maintainer 600+);
  lane scopes = `project_member_scopes` + PUT route (slice 5).

## 3. Design

### 3.1 Foundation: per-lane portfolio + lane threading (server + client lib)

- `PortfolioProject` gains `lanes: Array<{ lane: string; totalCells: number; filledCells:
  number; validatedCells: number; lastEditAt: number | null }>` — aggregated in the portfolio
  endpoint from `file_section_progress` file-scope rows (`GROUP BY target_lang`; the rows
  exist since migration 0055 — this is a SUM, not new bookkeeping). `lane: ''` row always
  present and labeled with the project's default `targetLanguage` client-side.
- `file-progress-resource.ts` gains a `lane` option threaded to the existing `?lane=` param
  (cache/ETag keys already lane-suffixed server-side; the IDB cache key gains the lane).
- Deep-link contract: **`/project/:id?lane=es`** — ProjectWorkspace reads the param once on
  mount and sets `activeLane` (then persists as today). Every PM surface links into the
  editor *at the lane it was looking at*.

### 3.2 OrgHome: the Language Grid (org altitude)

The portfolio table's project rows become **expandable**:

- **Collapsed** (default): a `Languages` column with compact lane chips —
  `fr ▓▓▓░ 68% · es ▓░ 22% · +2` (chip = lane tag + mini translated-bar; default lane first).
  N=1 projects show the single target chip they effectively show today — no visual regression.
- **Expanded**: one sub-row per lane —
  `lane | translated % | validated % | people (avatars of lane-scoped members + assignees) |
  last activity | actions`. Actions per lane sub-row:
  - **Open** → `/project/:id?lane=<tag>`
  - **Assign…** → AssignModal pre-scoped to the lane (§3.5)
  - **Staff…** → one-gesture add-person-to-lane (§3.4)
- **Project-row action: "+ Language"** (maintainer 600+) — popover with the same validation
  as LanguagesSection, PATCHes `targetLanes`. *This is "add languages from the org
  dashboard."* The Languages settings section remains the detailed manager (remove, notes).
- StatTile strip stays cross-lane (org averages). A `Stalled` refinement can later count
  stalled *lanes* rather than projects — out of scope v1.

### 3.3 ProjectOverview: the per-project lane table (project altitude)

New **Languages** section directly under the header StatTiles:

```
Language   Translated   Validated   People            Last activity   Actions
français   ▓▓▓▓▓▓▓░ 71%  54%         (avatars)          2h ago          Open · Assign · Staff
español    ▓▓░░░░░░ 22%  8%          (avatars)          3d ago          Open · Assign · Staff
+ Add language
```

- Data: the project's `PortfolioProject.lanes` (§3.1) + lane-scoped members (GET scopes per
  sub-500 member — already how SharePanel loads them) + per-lane assignments (§3.5).
- The header StatTiles gain a **lane filter pill row** (`All · fr · es · …`); selecting a lane
  re-reads file progress with `?lane=` (client threading from §3.1) so the per-file drill-down
  becomes lane-true instead of silently default-lane (today's behavior — a real PM trap once
  N>1 exists).

### 3.4 People management from the dashboard (people altitude)

- **Mount `MembersMatrixView`** at `/members?tab=matrix` (a tab on the existing MembersPage,
  keeping one "people" home). It already does org-wide per-project role editing; extend each
  matrix cell with **lane-scope chips** (`es`, `fr·MRK`) read from `project_member_scopes`,
  editable via the same scopes editor SharePanel uses.
- **One-gesture staffing** ("Add María as reviewer on Spanish") — a single `StaffLanePopover`
  used by OrgHome lane sub-rows, ProjectOverview lane rows, and the matrix:
  person picker (org roster) + role select (defaults reviewer) + the lane pre-filled →
  one confirm performs: ensure project membership at role (existing POST /members) + PUT lane
  scope. Leads/maintainers are added unscoped (server already rejects scoping 500+; the UI
  says "leads see all languages").
- Org-tier roles (`/members` roster) stay lane-less by design — org roles inherit everywhere;
  lanes are a *project*-member concept. The matrix makes that legible instead of implicit.

### 3.5 Assignments meet lanes

- `assignment.create`/`.reassign` payloads gain optional `targetLang` (same `''`-omitted
  convention as every other lane field); `assignments` table/projection stores it.
- AssignModal gains a lane select — pre-filled from context (workspace: active lane; PM
  surfaces: the lane row it was launched from). Default `''` keeps every existing flow
  byte-identical.
- `AssignedToMe`, `ProjectAssignedToMe`, and `WorkloadRollup` show a lane chip on each
  assignment; opening an assignment deep-links with `?lane=`.
- Assignment (which cells, deadline) and scope (hard permission wall) stay **separate
  concepts** — staffing (§3.4) grants the wall; assigning hands out work inside it. The UI
  copy must keep this distinction ("assigned to Spanish" vs "restricted to Spanish").

## 4. What this deliberately does NOT do (v1)

- No new "initiative" entity — the project remains the container; lanes remain the dimension.
- No per-lane deadlines (deadline stays per-project; revisit if PMs ask).
- No lane-level org StatTile averages (cross-lane averages remain).
- No portfolio push/realtime — PM surfaces stay read-on-load like today.

## 5. Sequencing (each independently shippable)

1. **Foundation** — portfolio `lanes[]` + client lane threading + `?lane=` deep link. (server
   + lib; no visible UI change; unblocks everything)
2. **ProjectOverview lane table + lane filter pills.** (the per-project PM story)
3. **OrgHome lane chips + expandable rows + "+ Language" quick action.** (the org PM story)
4. **StaffLanePopover + matrix tab mount + scope chips.** (people story)
5. **Assignment lane dimension.** (work-routing story)

Plus the already-agreed creation fix (multi-select target languages in the create dialog),
which slots in anywhere — it writes the same `targetLanes` registry.

## 6. Open questions for Ryder

1. OrgHome lane exposure: chips + expandable rows (proposed), or a dedicated org-level
   "Languages" pivot table (rows = languages across all projects — "how is Spanish doing
   org-wide")? The pivot is a natural v2 once `lanes[]` exists; starting with per-project
   expansion keeps the table familiar.
2. Should "Staff…" offer assignment in the same popover (grant + assign in one gesture), or
   keep staffing and assigning as two clicks? (Proposed: two — the concepts differ.)
3. Matrix tab on `/members` vs a section on OrgHome — where do you expect to *look* for
   cross-project people management?
