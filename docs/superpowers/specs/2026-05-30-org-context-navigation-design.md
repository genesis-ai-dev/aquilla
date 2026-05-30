# Org Context & Navigation — Linear-Style Org Workspace

**Status:** Design
**Date:** 2026-05-30
**Scope:** Introduce an explicit **organization context** to the SPA. A top-left switcher selects a single **active org**; the app gains two distinct context modes — **org context** (sidebar of Projects + Teams, breadcrumbs, a portfolio Overview) and the existing **project workspace** (sidebar of files). Phase 1 ships the structural split, the switcher, an org-scoped projects list, read-only Teams, and a placeholder Overview. Phase 2 (separate spec) fills in the distilled Overview, Teams lifecycle/management, org-scoped Members admin, and org create/rename.

Related: [App Shell Redesign](2026-04-17-app-shell-linear-layout-design.md) (workspace chrome), [Project Membership & Flat Orgs](2026-04-24-project-membership-and-orgs-design.md) (org/membership backend), [v3 audit — projects/orgs/membership](../../v3-audit/03-projects-orgs-membership.md), and `~/frontierrnd/aquilla-specs/01-personas-and-roles.md` (personas, role ladder, groups, AD-12 max-wins).

---

## Motivation

Today the app has no notion of "which org am I in." You land on a flat dashboard (`Dashboard.tsx`) that lists every project you can touch — across *all* orgs you belong to — with no grouping, no org label, and no way to tell whether a project lives in your personal workspace or in an org someone else owns. The org switcher does not exist; `useOrg()` fetches only the org you *own* (`GET /api/v2/orgs/me`).

This blocks the org-administrator personas (`01-personas-and-roles.md` → director-of-projects, VP, onboarding manager). A manager like Come and See's portfolio leads needs to live *inside* an org, see its projects and teams, and oversee progress. The data model already supports all of this (org membership, groups, AD-12 max-wins resolution); the **client never surfaces the org as a navigable context.**

Linear's model fits Aquilla's mental model exactly: you are always inside one workspace (org); a top-left switcher changes it and re-scopes everything; projects are the unit you drill into; selecting a project changes the main area. We adopt that shape.

## Goals

1. **Single active org** with a top-left switcher listing every org the user is a *member* of (owned + invited), each with the user's resolved role. Switching re-scopes the whole org context.
2. **Two explicit context modes.** Org context (Overview · Projects · Teams, plus admin Members · Settings) and the existing project workspace (files + editor). "Open project" is the transition from org → workspace.
3. **Surface org context everywhere:** breadcrumbs (`Org › Projects › Project`), the switcher's org name + role badge.
4. **Preserve personal-org-on-signup** (lazy server-side creation) and make it *visible* as the default switcher entry.
5. **One org-scoped projects list** — no local/cloud split (a dead Yjs-era distinction; on-device caching is invisible).
6. **Overview for everyone**, scoped to the projects the viewer can access — role only changes breadth and which management affordances appear. No role branch on landing.
7. **Read-only Teams** (the UI label for `groups`) as a secondary access lens in the sidebar.

## Non-Goals (deferred to Phase 2 / Teams-lifecycle work)

- The distilled Overview content (attention-ranked projects, portfolio rollup, velocity, audio progress, archive-from-overview). Phase 1 ships a **placeholder** Overview.
- **Teams lifecycle/management:** create/rename/delete a team, add/remove members, attach/detach projects at a role. Phase 1 is read-only.
- **Org create / rename** (`POST /api/v2/orgs`, `PUT /api/v2/orgs/:id`). Until these ship, orgs keep their auto-name `"<username>'s workspace"`; "Come and See"-style naming is not yet possible.
- Org-scoped **Members** admin surface beyond what `MembersPage` already does (re-point it at the active org; the richer roster/Teams admin is Phase 2).
- Billing, usage limits, IP-confidentiality controls (personas Q27/Q32).
- URL-encoding the active org into every route (see Open Questions); Phase 1 keeps active org in persisted client state.
- Any change to the editor/workspace internals.

---

## Current State (verified against code, 2026-05-30)

**Backend (`auth-worker`):**

- `GET /api/v2/orgs/me` ([orgs.ts:29](../../auth-worker/src/routes/orgs.ts)) → the caller's **owned** org only. `getOrCreateUserOrg` ([org-permissions.ts:17](../../auth-worker/src/services/org-permissions.ts)) selects `WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1` and lazy-creates `"<username>'s workspace"` + an `org_members` owner (700) row if none exists. **No endpoint lists orgs you're a member of.**
- `GET /api/v2/projects` ([projects.ts:190](../../auth-worker/src/routes/projects.ts)) already computes **AD-12 max-wins** across `project_members` + `group_project_grants` + `org_members` + creator, and returns projects from every org you belong to. **But the response is `{id, name, role:{level,name,source}, files}` — it does not include `org_id`,** so the client cannot group by org. Archived projects are already excluded (`WHERE p.archived_at IS NULL`).
- `POST /api/v2/projects` ([projects.ts:152](../../auth-worker/src/routes/projects.ts)) stamps `org_id = getOrCreateUserOrg(user).id` — always the creator's **personal** org, never a selectable one.
- Org member CRUD is fully built ([orgs.ts](../../auth-worker/src/routes/orgs.ts)): `GET /orgs/:orgId/members`, `POST` (owner-only, 700), `DELETE` (owner-only), `GET /orgs/:orgId/members/:userId/projects`, `GET /orgs/:orgId/invites`.
- **Groups:** schema exists ([migration 0007](../../auth-worker/migrations/0007_ad12_groups.sql): `groups`, `group_members`, `group_project_grants`) and is consulted in role resolution ([listEffectiveProjectMembers](../../auth-worker/src/services/org-permissions.ts) and the projects-list query). **No group read or CRUD endpoints exist; no client UI.**
- Project **archive** exists ([projects.ts:320](../../auth-worker/src/routes/projects.ts), owner-only); archived projects already drop out of the list.

**Client (`src`):**

- `useOrg()` ([useOrg.ts](../../src/hooks/useOrg.ts)) → `/orgs/me` (owned org). `useOrgMembers(orgId)` wraps the member CRUD.
- `MembersPage.tsx` is the de-facto org-admin surface (roster + multi-project invite) but is **not advertised** in the dashboard and targets `/orgs/me`, i.e. only your owned org.
- `Dashboard.tsx` renders a flat "Your projects" + "Your cloud projects" split — the latter is obsolete under the v3 (D1-only, no-Yjs) architecture.
- `AppShell.tsx` + `AccountSwitcher` exist for the *workspace*; `AccountSwitcher` switches **user accounts**, not orgs.

**Implication.** The gap is **context surfacing, not access.** A member already sees an org's projects (mixed flat); they just can't see which org they belong to, switch into it, or navigate it. Phase 1 closes that with one new list endpoint + small response/scoping changes.

---

## Architecture Overview

Two context modes share the same outer frame; the sidebar contents and main area differ.

```
ORG CONTEXT (new)                              PROJECT WORKSPACE (today, unchanged)
┌─ OrgSwitcher  (Come and See ▾ · Owner) ─┐    ┌─ AccountSwitcher ───────────────┐
│  Overview      ← portfolio (placeholder)│    │  Files…                         │
│  Projects      ← org-scoped list (1°)   │    │   (ExpandableFileList)          │
│  Teams         ← groups, read-only (2°) │    │  Project: Rules/Comments/…      │
│  ───                                    │    │  ⌘K                             │
│  Members       ← admin only             │    └─────────────────────────────────┘
│  Settings      ← admin only             │     Main: WorkspaceHeader + Editor
│  ⌘K                                     │     Breadcrumb: Org › Projects › P › file
└─────────────────────────────────────────┘
 Breadcrumb: Org › Projects › [Project]
 Main: Overview │ Team detail │ Project overview (+ "Open project")
                                   │
                       "Open project"  ─────────────►  enters PROJECT WORKSPACE
```

- The **OrgSwitcher** replaces nothing in the workspace; it is the org-context analogue of the workspace's `AccountSwitcher`, pinned top-left of the org-context sidebar.
- Clicking a **project** in Projects (or Teams) opens its **overview** in the main area — *still in org context*, no heavy project load.
- Clicking **Open project** routes to `/project/:id` (existing workspace). A back affordance in the workspace returns to org context.

---

## Data Model

No schema changes in Phase 1. The `groups` / `group_members` / `group_project_grants` tables (migration 0007) and `org_members` (migration 0016) already exist and are sufficient for read-only Teams and the org switcher.

Client adds one piece of persisted state (not IndexedDB-synced):

- `activeOrgId` — `localStorage` key `org:active`. The id of the org the user is currently inside. Hydrated/validated against `GET /api/v2/orgs` on load; falls back to the user's personal (lowest-id owned) org if unset or stale.

---

## Endpoints (Phase 1)

All under `/api/v2`, all auth-required.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| `GET` | `/orgs` | any auth | **NEW.** List every org the caller belongs to: union of owned orgs and `org_members` rows. Returns `[{id, name, role:{level,name}}]`. Lazy-creates the personal org (same as `/orgs/me`) so a brand-new user always gets ≥1 entry. |
| `GET` | `/projects?orgId=:id` | any auth | **MODIFY.** Add `orgId` to each project in the response. When `orgId` query param is present, filter `WHERE p.org_id = :orgId`. The existing AD-12 max-wins resolution is unchanged. |
| `POST` | `/projects` | org role ≥ `maintainer` (600) in the target org | **MODIFY.** Project creation is an **org-level** function (not a project-ladder rung — you can't be `project_lead` on a project that doesn't exist yet). Accept optional `orgId` in the body = the active org; gate on the caller's resolved `org_members` role ≥ 600 in that org. Omitted `orgId` falls back to the personal org, where you're always owner (700). `created_by` still grants creator/owner (700) on the new project. Refines the personas capability table — see Risk 3. |
| `GET` | `/orgs/:orgId/groups` | org member | **NEW.** List teams (groups) in the org: `[{id, name, memberCount, projectCount, viewerIsMember}]`. |
| `GET` | `/orgs/:orgId/groups/:groupId` | org member | **NEW.** Team detail: `{id, name, members:[{userId,username,roleLevel}], projects:[{id,name,grantedRoleLevel}]}`. Read-only. |

### Response shapes

```ts
// GET /api/v2/orgs
{ orgs: Array<{ id: number; name: string | null; role: { level: number; name: string } }> }

// GET /api/v2/projects (projects[] gains orgId)
{ projects: Array<{ id: string; name: string; orgId: number | null;
                    role: { level: number; name: string; source: "override"|"group"|"org"|"creator" };
                    files: FileSummary[] }> }

// GET /api/v2/orgs/:orgId/groups
{ groups: Array<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean }> }

// GET /api/v2/orgs/:orgId/groups/:groupId
{ id: number; name: string;
  members: Array<{ userId: number; username: string; roleLevel: number }>;
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }> }
```

Error shape stays `{ error: string }`.

### New service helpers (`auth-worker/src/services/org-permissions.ts`)

- `listUserOrgs(env, user)` — union of `SELECT id,name FROM organizations WHERE owner_user_id = ?` and `SELECT o.id,o.name,om.role_level FROM org_members om JOIN organizations o … WHERE om.user_id = ?`, deduped by org id, owner role taking precedence. Lazy-creates the personal org if the union is empty.
- `listOrgGroups(env, orgId, userId)` and `getOrgGroupDetail(env, orgId, groupId)` — read-only group queries with the org-membership gate.

---

## Client Architecture (Phase 1)

### Active-org state — `OrgContextProvider` (new, `src/context/OrgContext.tsx`)

Holds `{ orgs, activeOrgId, activeOrg, setActiveOrg, isLoading, error }`. On mount (with a session) it fetches `GET /api/v2/orgs`, hydrates `activeOrgId` from `localStorage:org:active` (validated against the list; falls back to personal), and persists on change. `useActiveOrg()` is the consumer hook. `useOrg()` is refactored to read the active org from this provider rather than calling `/orgs/me` directly (kept as a thin wrapper for back-compat during migration).

### `OrgSwitcher` (new, `src/components/org/OrgSwitcher.tsx`)

Top-left of the org-context sidebar. Shows active org name + role badge + chevron. Menu lists every org from `useActiveOrg().orgs` with its role; selecting one calls `setActiveOrg`. A disabled **"Create org — coming soon"** row marks the Phase 2 seam (no create endpoint yet). Mirrors `AccountSwitcher`'s interaction patterns.

### Org-context shell + routing

New routes (active org from state, **not** the URL — see Open Questions):

| Route | Surface |
|---|---|
| `/` | Org home → **Overview** (placeholder) |
| `/projects` | Org-scoped Projects list |
| `/projects/:id` | Project **overview** (+ Open project) |
| `/teams` | Teams list (read-only) |
| `/teams/:groupId` | Team detail (read-only) |
| `/members` | (existing) re-pointed at the **active** org |
| `/settings` | (existing) org settings, admin-gated |
| `/project/:id` | (existing) **project workspace** — the "Open project" target |

The org-context shell reuses the `AppShell` frame; a new `OrgSidebar` renders the section list (Overview/Projects/Teams + admin entries) and `OrgBreadcrumb` renders `Org › …`.

### Projects list (org-scoped)

Replaces the flat `Dashboard` sections with one list from `GET /api/v2/projects?orgId=<active>`. Each row: name, your role badge, a lightweight progress signal (translated/validated counts already available via `files`), and click → `/projects/:id` overview. The "Your projects / Your cloud projects" split and its dedup logic are removed.

### Project overview (minimal, Phase 1)

`src/components/org/ProjectOverview.tsx` — name, your role, file/cell counts, and a primary **Open project** button → `/project/:id`. The rich progress dashboard is Phase 2; this is deliberately thin.

### Teams (read-only)

`TeamsList` (from `/orgs/:orgId/groups`) and `TeamDetail` (from `/orgs/:orgId/groups/:groupId`) — list teams you can see, open one to view members + attached projects. Empty state when the org has no groups (common today). No create/edit affordances.

### Overview placeholder

`src/components/org/OrgOverview.tsx` — a single card with the org name, project count, and a "Portfolio insights coming soon" note. The seam where Phase 2 lands.

### New client modules

- `src/lib/frontier/orgs.ts` — add `listMyOrgs()`; `src/lib/frontier/teams.ts` — `listTeams`, `getTeam`.
- `src/lib/frontier/projects.ts` (or existing reads) — thread `orgId` into the list call and surface `orgId` on the project type.
- `src/context/OrgContext.tsx`, `src/hooks/useActiveOrg.ts`.
- `src/components/org/*` — `OrgSwitcher`, `OrgSidebar`, `OrgBreadcrumb`, `ProjectsList`, `ProjectOverview`, `TeamsList`, `TeamDetail`, `OrgOverview`.

---

## Data Flow

### Landing / switching orgs

1. Session hydrates → `OrgContextProvider` fetches `GET /api/v2/orgs`.
2. `activeOrgId` read from `localStorage`; if absent/stale → personal org.
3. Org-context surfaces (Overview/Projects/Teams) read `activeOrgId`; the Projects list calls `/projects?orgId=<active>`.
4. User picks another org in `OrgSwitcher` → `setActiveOrg` updates state + `localStorage`; surfaces re-fetch. No reload.

### Org → project → org

1. In Projects (or a Team's project list), click a project → `/projects/:id` overview (org context).
2. Click **Open project** → `/project/:id` (workspace). Workspace breadcrumb shows `Org › Projects › Project`.
3. Back affordance → returns to org context (`/projects` or the project overview).

### Creating a project in the active org

1. Create dialog submits with `orgId = activeOrgId`.
2. Server gates on caller's org role ≥ `maintainer` (600) in that org; inserts `projects(org_id = activeOrgId, created_by = user)`.
3. New project appears in the active org's Projects list (creator → owner via AD-12).

---

## Roles & Visibility

One role-resolved surface (per `01-personas-and-roles.md`: "the UI must not gate options on archetype membership, only on resolved role"):

- **Everyone** sees Overview + Projects + Teams scoped to what they can access. A contributor sees their projects' progress; an owner sees all.
- **Members / Settings** sidebar entries appear only at org role ≥ `maintainer` (600) or org owner — matching the existing owner-gated member CRUD.
- **Create project** affordance appears only when the caller's org role ≥ `maintainer` (600) — creating a project is an org-admin function.
- Teams are read-only for all in Phase 1; the management gate (≥ 600 / owner) is wired when Teams lifecycle ships.

Managers' "portfolios" (e.g., Come and See's three leads, each over a set of languages) are **not** a modeled entity — they are permission grants: direct `project_members` rows today, or a Team (group) attached to the relevant projects once Teams management exists. Phase 1 surfaces these; it does not create them.

---

## Phasing

**Phase 1 (this spec) — the structural split:**
- `GET /api/v2/orgs`; `org_id` on the projects list + `?orgId` scoping; create-into-active-org; read-only group endpoints.
- `OrgContextProvider` + `OrgSwitcher` + org-context shell/routing/breadcrumbs.
- Org-scoped Projects list (removes local/cloud split); minimal Project overview + Open project.
- Read-only Teams; placeholder Overview.
- Re-point `MembersPage` at the active org.

**Phase 2 (separate specs):**
- **Distilled Overview:** attention-ranked projects (stalled/behind/blocked), portfolio rollup, velocity/projected-finish, **audio progress** (Randall's feedback), and excluding archived projects from the rollup. Source the metric vocabulary from codex-website's PM portal (`ComputedProjectMetrics`) but distilled.
- **Management functions (org-admin tier):** **project archive/untrack** (Randall's feedback — a broad management function, surfaced wherever projects are listed, not Overview-specific); **Teams lifecycle** — create/rename/delete, membership, project attachment at a role — plus the effective-access / revoke-all-paths surfaces (`04-features/members-and-sharing.md`).
- **Org create / rename** (so "Come and See" can be named); org-scoped Members admin.

---

## Testing

**Backend (vitest):**
- `listUserOrgs` — owner-only, member-only, owner+member dedup, empty → lazy personal org.
- `/projects?orgId` — filters correctly; `org_id` present in response; AD-12 resolution unchanged; archived still excluded.
- `POST /projects` — `orgId` honored; gate rejects org role < 500; omitted `orgId` → personal org.
- group read endpoints — org-member gate (403 for non-members); shapes correct.

**Client (RTL):**
- `OrgContextProvider` hydrates active org from `localStorage`, falls back to personal, persists on switch, recovers from a stale id not in the list.
- `OrgSwitcher` lists orgs + roles; switching re-scopes the Projects list.
- Projects list shows only the active org's projects; clicking → overview; Open project → `/project/:id`.
- Teams list/detail render read-only; empty state when no groups.
- `MembersPage` operates on the active org id.

**E2E:** one happy-path spec — log in as a user who is a member of two orgs (personal + one they were added to), switch orgs, confirm the Projects list changes, open a project, return to org context.

---

## Risks & Open Questions

1. **Active org in state vs URL.** Phase 1 keeps `activeOrgId` in `localStorage`, not the route. Simpler, but cross-org deep links and back/forward across orgs are imperfect. URL-encoding (`/orgs/:orgId/projects`, Linear-style) is the robust long-term shape — proposed as a fast follow once the surfaces stabilize. **Decision needed: accept state-only for Phase 1?**
2. **Users who own multiple orgs.** `owner_user_id` permits it; `/orgs/me` arbitrarily returns the lowest id. `GET /api/v2/orgs` lists all owned + member orgs, so the switcher is correct regardless — but until org-create exists, the only multi-owned case is data created out-of-band. Low risk.
3. **Create-project gate level — resolved 2026-05-30.** Org role ≥ `maintainer` (600). Project creation is an org-level function, not the project-ladder `project_lead` rung. In a personal org you're owner (700), so solo users are unaffected. **Follow-up:** `~/frontierrnd/aquilla-specs/01-personas-and-roles.md`'s capability table lists project creation at `project_lead` (project-ladder framing); update it to express this as an org-level capability (≥ org `maintainer`). *Phase 2 nuance:* once managers hold a low org-wide role but get scoped portfolios via Teams (groups), "can create in this org" may also need to consider group-admin status — revisit with Teams lifecycle.
4. **"Come and See" naming.** Not achievable in Phase 1 (no org create/rename). The switcher shows `"<username>'s workspace"`. Flagged so demos don't expect custom org names yet.
5. **Teams may be empty for everyone.** No group-create path exists, so most orgs have zero groups; the Teams section will commonly show an empty state until Teams lifecycle ships. Acceptable — the section establishes the IA.
6. **`MembersPage` re-point.** Moving it from `/orgs/me` to the active org changes which org an existing owner manages by default. Verify no flow assumed "always my personal org."
7. **Stale dead code.** The `"gitlab"` role source (`members.ts`) and the "Your cloud projects" split are removed/avoided here; coordinate with the v3-audit findings (F4–F6) so we don't reintroduce them.
