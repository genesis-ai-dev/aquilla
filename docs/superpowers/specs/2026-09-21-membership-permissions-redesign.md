# Membership & permissions redesign — one grant, four scopes

**Status:** Proposal for team discussion · 2026-09-21 · Ryder (drafted with Claude)
**Inputs:** Ryder↔Kieran call 2026-09-21 08:36–08:49; Tim's blocker (Discord, 2026-09-21 19:46);
Come and See / Biblica / E10 partner calls (AQU-984, AQU-1026, AQU-1107, AQU-1274); Luke's lane
spec `2026-09-10-lane-permissions-and-read-wall-design.md` (PR #719); prior-art review of GitLab,
GitHub, Notion, Linear, Figma, Google Drive, and Zanzibar-style ReBAC.
**Linear:** AQU-1352 (single ticket, Todo, Ryder); supersedes the canceled AQU-835; absorbs AQU-984, AQU-1030, AQU-1026, AQU-730,
AQU-553, AQU-528, AQU-1072, AQU-1073, AQU-1322, AQU-853, AQU-504.

---

## 0. The problem in one paragraph

Today "what can user U do on project P?" is answered by **eight** independent sources:
`org_members.role_level`, `group_members` ⋈ `group_project_grants.role_level`,
`project_members.role_level`, the implicit creator-owner path, the platform-admin email list,
restrictive `project_member_scopes` (lane/file), the new additive `project_member_lane_roles`
(PR #719, unwired), and eight `org_settings` role floors. Two resolvers implement the merge
(`auth-worker/src/services/project-permissions.ts` and `db/shared/project-roles.ts`), and the
merge rule has already flipped once ("most specific wins" → max-wins + inherit, AQU-1274). The
UI exposes every one of these knobs separately. Nobody, including us, can predict the effective
result, and the create form cannot even say *where* a project will land.

Tim's case is the canonical symptom. The GitLab import gave him **Guest on org "Personal
Projects"** and **Owner on team "tim"**. `POST /api/v2/projects` requires org role ≥ Maintainer
(`auth-worker/src/routes/projects.ts:357`) and ignores team roles entirely; `ProjectCreateDialog`
has no container picker and always passes the active org. Result: an Owner who cannot create
anything, and a generic "You don't have permission to do that for this project."

## 1. What partners actually need (requirements, not features)

| # | Requirement | Source |
|---|---|---|
| R1 | An org admin sees and administers everything. | every partner |
| R2 | A **PM sees only the projects they manage**, but can fully run them: settings, languages, staffing, assignments. Come and See: 150 projects, 4–5 PMs with different slices. | AQU-984 (E10: "Joy, Bubble, me and Margo are all in the same role now"), AQU-1026 |
| R3 | A **translator sees only their project(s)**, and, when a project has many lanes, **only their lane(s)**. | AQU-1107, AQU-730, AQU-1026, Kieran call |
| R4 | Being added to an org must **not** grant access to anything by itself. | AQU-1107 workaround ("add to org → add to project → remove from org"), Ryder 08:41 |
| R5 | Anyone who owns *a* container can **create a project in it**, and the create form must let them choose the container. | Tim |
| R6 | Granter must always know **which scope** they are granting (org / team / project / lane) without extra dialogs. | AQU-1030, AQU-504, AQU-488 |
| R7 | An admin can answer "who has access to what, and *why*" and export it. | AQU-1072, Ryder 08:39 ("a tree… who has access at this level") |
| R8 | External translators can be added to a project/lane without joining the org. | AQU-607, AQU-528 |
| R9 | Support (platform admin) can repair membership anywhere, audited. | AQU-1322 |
| R10 | Agent API / PATs keep working with the same resolver; changesets re-check live membership. | AQU-1185, AQU-1235, AQU-723 |

## 2. Prior art, condensed

- **GitLab** (our origin): tree inheritance with max-over-ancestors is fine *as math*; the
  documented defects are UX — no scope choice at create time, no direct-vs-inherited display,
  and "Minimal Access in parent + Owner in subgroup" 404s (gitlab-org/gitlab#351378, #26571).
  GitLab's answer was custom roles, not smarter inheritance.
- **GitHub**: three axes kept apart — org role (tiny), repo role (per-object), **teams as the
  delegation unit**. Repo-create has an explicit **Owner picker**. That picker is the direct fix
  for R5.
- **Linear / Notion / Figma**: 3–4 fixed workspace roles, a mid-tier container (team /
  teamspace) that is the real unit of grant, and **guests hard-scoped to specific objects,
  never inheriting workspace-wide anything**. Private teams are invisible to non-members
  structurally, not via a flag.
- **Google Drive**: shipped a second, stricter container (Shared Drives: no per-file override)
  rather than adding override knobs to the first. Lesson: fewer override points, not more.
- **ReBAC (Zanzibar / SpiceDB / OpenFGA)**: right *mental model* — every grant is
  `(subject, role, resource)` and effective access walks the resource graph — but the engine is
  unjustified for a shallow, mostly static 4-level tree at our scale. Postgres with one grants
  table and an ancestor walk is enough; revisit only if resources stop being a tree.

Convergent answer across all of them: **one grant shape, one fixed small role ladder, one
resolution rule (max over ancestors), a container that is the unit of delegation, guests scoped
to objects, and UI that always shows where access comes from.**

The last point is why GitLab's model survives its complexity: inheritance is *explicit* on every
member list (Direct / Inherited from X) and behaves identically at every level. Our current UI
hides the merge, which is why AQU-1274 went unnoticed until a partner call. Section 3.7 makes
explicitness a contract, not a nicety.

## 3. The model

### 3.1 Four scopes, one hierarchy

```
Organization
└── Team            (a bucket of projects and people; a project may sit in several teams, or none)
    └── Project
        └── Lane    (target language)
```

- **Team is a container of projects and people, and a project can be in several teams.** This
  is Ryder's "subgroups in GitLab" instinct and AQU-1073's "group projects like Discord channels"
  in one move. Membership in a team is a grant at team scope that flows down to every project in
  it; the per-team-per-project `role_level` on `group_project_grants` goes away and the table
  shrinks to a plain `team_projects (team_id, project_id)` link. A project's ancestors are its org
  plus every team it belongs to, so the max rule still applies unchanged. A PM who runs
  projects across two teams simply holds two team grants.
- **Org membership is a directory entry, not a permission** (R4). `org_members` keeps a
  `role_level` of *Owner* or *Maintainer* for admins; everyone else is a plain **Member** with
  no access until granted somewhere below. Below-600 org roles already contribute nothing since
  AQU-1107; this makes the schema say so.
- **External people** (R8) hold grants on a project/lane without an `org_members` row. They
  appear in that project's roster tagged *Guest*, exactly as `guestOrgs` already tags them in the
  switcher (AQU-473).

### 3.2 One grants table

```sql
CREATE TABLE access_grants (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  scope_type  TEXT   NOT NULL CHECK (scope_type IN ('org','team','project','lane')),
  scope_id    TEXT   NOT NULL,             -- org id | team id | project id | project_id/lane_id
  role_level  INTEGER NOT NULL,            -- the existing 100..700 ladder
  granted_by  BIGINT,
  granted_at  TIMESTAMPTZ DEFAULT now(),
  source      TEXT NOT NULL DEFAULT 'direct',  -- direct | invite | gitlab_import | platform
  UNIQUE (user_id, scope_type, scope_id)
);
```

`org_members` (roster + admin role), `project_members`, `group_members`, `group_project_grants`,
`project_member_scopes(kind='lane')`, and `project_member_lane_roles` all collapse into this.
`project_member_scopes(kind='file')` is out of scope and stays as-is (book-scoped reviewers,
AQU-553 file half). The creator-owner path and platform-admin path become **rows** written at
create time / admin-elevation time, so the resolver has no special cases and the audit report
(R7) is a plain query.

### 3.3 One resolution rule

```
effectiveRole(user, node)  = max(role_level of grants on node and every ancestor of node)
canSee(user, node)         = effectiveRole(user, node) exists
                             OR user holds a grant on any DESCENDANT of node   -- navigation only
canDo(user, node, action)  = effectiveRole(user, node) >= floor(action, orgSettings)
```

- **Grants only ever add.** A lower grant on a narrower scope never demotes (the AQU-1274 bug
  becomes unrepresentable). To *restrict* someone you remove or lower the broad grant, and the
  UI shows you which one.
- **Descendant-visibility** is what fixes the GitLab #351378 class: Tim, Owner on team `tim`,
  sees the org "Personal Projects" in the switcher as a bare container with only his team inside.
- **Lane rule** matches Luke's spec §1.1 verbatim: `canAccessLane = effectiveRole(project) ≥ 600
  OR grant(lane) exists`; inside a lane the role is `max(project role, lane role)`. A translator
  with a lane grant and nothing above it sees the source, their lane, and no sibling lane names or
  counts (metadata wall, spec §2). PR #719's `project_member_lane_roles` is the first
  `scope_type='lane'` slice of this table; merge it as-is and migrate rows in Phase 3.

### 3.4 Roles: same ladder, offered per scope

Keep the seven numeric levels (too much server policy keys off them) but **stop offering all
seven everywhere**. Separation of concerns is: *administrative* roles live on containers,
*operational* roles live on work.

| Scope | Roles offered in the picker | Meaning |
|---|---|---|
| Org | Owner 700 · Maintainer 600 · *(Member = no grant)* | administer everything |
| Team | Maintainer 600 · **Project Lead 500** · Viewer 100 | run / oversee this folder of projects (the Come and See PM) |
| Project | Project Lead 500 · Contributor 400 · Reviewer 300 · Commenter 200 · Viewer 100 | run / work on one project |
| Lane | Contributor 400 · Reviewer 300 · Viewer 100 | work in one language |

**Project Lead becomes the PM role (R2, AQU-984):** at 500 a user can edit project settings
including languages (AQU-1086 already ships this behind `languageEditMinRole`; move the default
to 500), staff the project up to Contributor, assign work, and **create projects** inside a team
they lead. They see nothing outside their grants. Maintainer is no longer the only way to be a
PM, so the E10 over-grant disappears.

Optional rename for the UI only (no code change): Project Lead → **Manager**, Contributor →
**Translator**. Decide in the meeting.

### 3.5 Creation (R5)

The create form shows its **org scope as a breadcrumb at the top** (`Personal Projects`,
switchable via the org switcher / an org picker listing every org the user can see, plus
*Personal*), and directly beneath it a **Teams multi-select combobox** listing the teams in that
org where the user holds a grant. The server accepts `{ orgId, teamIds[] }` and allows creation
when `effectiveRole(org) ≥ 600` **or** `effectiveRole(team) ≥ 500` for at least one selected
team (defaults; org-configurable later). It checks this through the *same* resolver, writes
`team_projects` rows for each selected team and the creator's Owner grant as a row. Tim sees
`Personal Projects`, picks team `tim` in the combobox, and is done; if he picks no team the form
explains that he is only a Member of the org and must choose a team he leads.

### 3.6 One surface (R6, R7)

Replace Org Members + Teams + project Share/Members + StaffLanePopover with **one "People &
access" page per org**, two views:

1. **Tree view** (Ryder's sketch): org → teams → projects → lanes, each node shows avatars of
   direct grantees; click a node to add a grant *at that scope*. The scope is the node you are on,
   so R6 costs zero extra dialogs.
2. **Person view**: one row per person, their grants as chips `Owner @ org`, `Project Lead @ team
   BSB`, `Contributor @ Pattani Malay / French`, each with *direct* or *inherited from …*. Filter
   by project shows effective role and its origin. Export = CSV/PDF of this table (AQU-1072).

Inside a project, "Members" is the same person view filtered to that project (AQU-488, AQU-853).
The invite/PAT/agent flows call the same grant endpoint with an explicit scope.

### 3.7 Inheritance is explicit, everywhere (the GitLab rule)

GitLab's model is tolerable because inheritance is never hidden: every member row on every
level says **Direct** or **Inherited from <ancestor>**, the rule is the same on every page, and
inherited rows cannot be edited where you are looking — only where they were granted. We copy
that discipline as a hard UI contract:

1. **Every roster row carries its origin.** Wherever a person appears (org, team, project, lane,
   share modal, assignee picker, Agent API member list) the row shows the effective role *and*
   a badge: `Direct`, `Inherited · team BSB`, `Inherited · org`, `Creator`, `Platform admin`. The
   API returns `{ role, source: { scopeType, scopeId, grantId } }` for every member; the badge is
   derived, never computed client-side.
2. **Inherited rows are read-only in place.** The role control on an inherited row is disabled
   and its tooltip says "Set at team BSB — change it there", with a link to that scope. You can
   only *add* a direct grant here (which, by the max rule, can only raise the effective role and
   is shown as a second chip), never silently lower or remove an inherited one.
3. **Effective role is always shown next to the direct role** when they differ:
   `Contributor (direct) → Project Lead (via team BSB)`. Never show one number alone.
4. **Removing asks the right question.** "Remove Naladda from Pattani Malay" removes only the
   direct grant. If access remains via inheritance the dialog says so before you confirm: "She
   will still have Project Lead access through team BSB. Remove that too?" (AQU-368's "Remove vs
   Revoke all access" becomes structural.)
5. **Counts are honest.** "12 members" on a project counts everyone with effective access,
   with a `(3 direct · 9 inherited)` breakdown on hover.
6. **The tree view and the person view show the same grants.** Same API, same badges; the
   tree is just grouped by scope and the person view by user. Direct grantees render as avatars on
   the node; inherited access is implied by the tree shape and not re-drawn on children.
7. **Denials explain the chain.** A 403 says "You are Viewer here (inherited from org). Project
   Lead is required." (extends AQU-623.)

Acceptance for Phase 4 includes a screenshot of the same person on all four scope pages showing
consistent badges, and a test that no role control is enabled on an inherited row.

### 3.8 The member inspector — transparency from anywhere

Explicit badges answer "what is this person here?". The inspector answers "what is this person
*everywhere*, and why?" without leaving the page. It is one component, opened from any avatar or
name: org roster, team page, project members, lane staffing, share modal, assignee picker,
comment author, presence indicator, audit report.

**Shape:** a popover (click) that expands to a side sheet ("See all access") for people with
many grants.

```
┌ Naladda Silawajanakul ─────────────────────────── Guest of Biblica ETT ┐
│ Effective here (Pattani Malay Bible):  Project Lead                       │
│   via  Project Lead @ team biblica/pattani-malay   (direct, by Joel, Sep 2)│
│   also Contributor  @ this project                 (direct, by Joel, Aug 30)│
│                                                                            │
│ Everything else                                                            │
│   Biblica ETT (org) ........................... Member · no access         │
│   team biblica/pattani-malay .................. Project Lead  ▸ 3 projects │
│   team biblica/bsb ............................ Viewer        ▸ 12 projects│
│   Living on the Edge / French (lane) .......... Reviewer                   │
│                                                                            │
│ [Manage access]   [Copy access report]                                     │
└────────────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Two sections, always in this order.** *Effective here* — the role at the scope you opened it
   from and the full chain of grants that produce it, highest first, each with scope, direct or
   inherited, who granted it and when. *Everything else* — every other grant this person holds
   that the **viewer is allowed to see** (see rule 4), grouped by scope type, with descendant
   counts on containers.
2. **Reads only from the resolver.** One endpoint,
   `GET /api/v2/users/:id/access?from=<scopeType>:<scopeId>`, returns the effective role, the
   contributing grants, and the visible remainder. The People & access person view, the audit
   export (AQU-1072) and this popover are three renderings of that one payload, so they cannot
   disagree.
3. **Actions are links, not controls.** "Manage access" jumps to the scope where a grant lives
   (or to People & access for the whole person). Nothing is edited from inside the inspector;
   that keeps the "change it where it was granted" rule from 3.7 intact.
4. **Scoped to what the viewer may know.** A Project Lead sees a member's grants only within
   projects and teams they themselves can see; an org Owner sees everything in the org; the
   `rosterViewMinRole` floor still gates whether the roster is listable at all. A person always
   sees their own full inspector ("Your access"), which also replaces the "which account am I"
   confusion in AQU-560.
5. **Guests are labelled as such** in the header (no org row), so the org-vs-project scope
   confusion in AQU-504 and AQU-1030 is answered by looking, not by asking.
6. **Agents get the same view.** The Agent API `members` read (AQU-1185) returns the same
   payload per member, so an external agent can explain access the way the UI does.

Phase 4 acceptance: open the inspector for the same person from org roster, team page, project
members and a lane row; the *Effective here* section differs, *Everything else* is identical.

### 3.9 Scope is always spelled out as a breadcrumb

A scope is a path in the hierarchy, and the UI writes it as one everywhere, never as a bare name:

```
Biblica ETT  ›  biblica/pattani-malay  ›  Pattani Malay Bible  ›  French
   org             team                    project                lane
```

1. **Every access page has the breadcrumb as its title.** The People & access page for a team
   reads `Biblica ETT › biblica/pattani-malay`; the project members panel reads
   `Biblica ETT › biblica/pattani-malay › Pattani Malay Bible`. The last crumb is the scope you
   are granting at; each earlier crumb is a link to that ancestor's access page.
2. **The "Add people" dialog repeats it in the header**, e.g. "Add people to *Biblica ETT ›
   biblica/pattani-malay › Pattani Malay Bible*", and the role picker below it offers only the
   roles valid at that depth (3.4). This is the whole answer to AQU-1030: the scope is stated in
   the same words on the page, in the dialog, and in the resulting grant chip, with no
   confirmation step.
3. **Grant chips, inspector rows, badges, denial messages and the audit export all use the same
   breadcrumb string** (`Inherited · Biblica ETT › biblica/pattani-malay`), produced by one
   helper from the resolver's `source.scopePath`. A scope is never referred to by two different
   names in two places.
4. **Guests get a truncated path.** Someone with only a project grant sees crumbs starting at the
   first scope they can see; ancestors they cannot see render as a faded placeholder (`… ›
   Pattani Malay Bible`), which also satisfies the metadata wall from Luke's spec.
5. **The container picker on create (3.5) is a breadcrumb picker**: options render as
   `Personal Projects › tim`, `Biblica ETT › biblica/bsb`, `Personal`, so the user chooses a
   path, not an org name.
6. **URLs mirror the path**: `/orgs/:orgId/teams/:teamId/projects/:projectId/access`, with
   `/project/:id/...` remaining a redirect alias. The breadcrumb is derived from the route, so it
   cannot drift from where you actually are.
7. **Projects in several teams.** The crumb shows the team you navigated through; reached
   directly (`/project/:id`), it shows `org › project` with the team memberships as chips beside
   the title (`in: biblica/bsb, biblica/pattani-malay`). Grant chips always name the specific
   team path the grant came from, so ambiguity never reaches the inspector.

Phase 4 acceptance: the breadcrumb in the page title, the add-people dialog header, and the
resulting grant chip are byte-identical for a grant made at each of the four scopes.

## 4. Decisions needed (recommendation in bold)

1. Team as **container with many-to-many project membership** (decided by Ryder 2026-09-21:
   projects are added to teams from a multi-select). Cost: a project's breadcrumb has to pick the
   team you navigated through (3.9 rule 7); the inspector lists every team path.
2. Org "Member" = **no access** by default. **Yes**; matches AQU-1107 and Ryder's 08:41 proposal.
3. Lane grants carry a level (Luke) vs. binary access. **Level**, but only operational roles.
4. Project creation floor: **500 on team, 600 on org**, org-configurable later.
5. Rename Project Lead → Manager in UI? **Yes**, partners already say "PM".
6. Keep Commenter/Reviewer as separate rungs? **Yes for now**; validation policy keys off 300.

## 5. Migration plan (each phase ships alone and is reversible)

**Phase 0 — unblock Tim this week (no schema change).**
- Container picker in `ProjectCreateDialog` fed by a new `GET /api/v2/me/create-targets`
  (orgs where org role ≥ 600 + personal org). Server unchanged.
- Support fix today: promote Tim to Maintainer on "Personal Projects", or have him create under his
  personal org (client must omit `orgId`).

**Phase 1 — one resolver, dual-read.** Create `access_grants`; backfill from all six tables
(creator and platform-admin included); make `db/shared/project-roles.ts` the single resolver
used by auth-worker, sync-worker, and Agent API, reading grants only. Old tables become
write-through mirrors. Characterization tests (AQU-268 style) pin every existing route's answer
before and after. Audit query for anyone whose effective role changes (expected: none, because
max-wins already holds).

**Phase 2 — teams become containers.** `team_projects (team_id, project_id)` replaces
`group_project_grants`; each `group_members` row becomes a team-scope grant at the role its
group grants carried (where a person's groups carried different levels on different projects,
keep the max as the team grant and add direct project grants for the rest; report the count).
Create form gains the org breadcrumb + teams multi-select; creation floor moves to the resolver. Org Member = no access; below-600 `org_members` rows become Members (they already
grant nothing).

**Phase 3 — lanes.** Merge PR #719; migrate `project_member_lane_roles` and
`project_member_scopes(kind='lane')` to `scope_type='lane'`; wire `resolveVisibleLanes` and the
read/metadata wall per Luke's spec. Retire the lane kind of scopes. AQU-528 lane-scoped invites
write lane grants.

**Phase 4 — the surface.** People & access page (tree + person views, export); remove Teams
page, StaffLanePopover, per-member team role pickers; permission-denial copy names the scope and
role (AQU-623). PostHog: `resolved_role`, `resolved_from` on `project settings hydrated`.

**Phase 5 — cleanup.** Drop mirrored tables, platform-admin email list → grants (AQU-1322 done),
GitLab `accessLevelToRoleLevel` import writes grants with `source='gitlab_import'`.

## 6. Ticketing

Filed as **one ticket, AQU-1352** (Todo, assigned Ryder) carrying the phase checklist, old-vs-new
QA notes, and the jev adversarial suite. Phases may be split into sub-issues after decisions D1–D6
close. The original breakdown is kept below for that split.

- **Epic:** Membership & permissions redesign — one grant, four scopes (this doc).
- P0: Container picker on project create + `me/create-targets` (fixes Tim).
- P1: `access_grants` table + backfill + single shared resolver + characterization suite.
- P2a: `projects.team_id` + group→team migration + report. P2b: Org Member = no access.
- P3: Lane grants on `access_grants` + read wall wiring (Luke; folds AQU-730/1026/553-lane/528).
- P4a: People & access page. P4b: Access audit export (AQU-1072). P4c: Denial copy names scope.
- P4d: `GET /users/:id/access` payload + member inspector popover/sheet, wired from every avatar
  surface (folds AQU-560, AQU-504 answers).
- P5: Retire mirrors + platform-admin grants (AQU-1322).
- Close as absorbed: AQU-984, AQU-1030, AQU-1073, AQU-853, AQU-504.

## 7. Non-goals

Custom role builder (AQU-835), per-book scopes beyond the existing file kind, an external
authorization engine, workflow/review-stage configuration (LaneQuest, 2026-09-14) — that layer
sits *on top* of effective role and is not touched here.
