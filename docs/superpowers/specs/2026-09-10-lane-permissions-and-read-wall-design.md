# Per-lane permissions + read wall + metadata isolation — Design

**Status:** Proposal for discussion · 2026-09-10 · Luke (w/ team permission)
**Linear:** AQU-730 (permission model + visibility decisions), interlocks with AQU-1240
(eliminate default lane) and AQU-1026 (partner per-lane assignment).
**Supersedes:** the *permission substrate* of `2026-09-09-lane-read-wall-design.md`. That doc's
read-path inventory, enforcement-choke-point analysis (`resolveReadLanes` authority + a branded
`LaneScopedRead` type), and slice structure are still correct and are **reused** here; only the
thing that feeds them changes — from *restrictive scopes* to *additive grants*.

---

## 0. What changed since the read-wall draft

The read-wall draft designed isolation on top of the existing `project_member_scopes` model,
where **having no scope rows means "all lanes."** The product owner has since made three
decisions that invert and extend that:

1. **Three permission tiers — org, project, and lane** — with *lane* now a first-class level
   alongside the org and project roles already resolved by `resolveProjectRole` (max-wins).
2. **Grant-based, not scope-based.** Below Maintainer (600), a member has access to a lane
   **only if explicitly granted it.** No grant ⇒ no access. This replaces the restrictive
   `project_member_scopes` mechanism (where absence = everything) with additive grants
   (where absence = nothing). Isolation becomes the *default consequence* of the model rather
   than a separate wall + setting.
3. **Metadata isolation.** A user who cannot access a lane must not learn its **content**, its
   **name**, or **even that it exists / how many lanes there are.** Lane existence and count are
   themselves gated. This is new surface beyond the content read wall.

Consequence for the earlier draft: the per-project `laneReadIsolation` setting (its §3) is **no
longer needed** — isolation is not opt-in, it is what grant-based access *is*. Its entire
"unscoped member = all lanes" analysis (its §4.3) flips. And because this lands alongside
AQU-1240 (no default lane), its single largest hazard section — the falsy-`''` tri-state param
analysis (its §4.1) — **collapses** (see §7).

---

## 1. The permission model

### 1.1 Three tiers, and how they compose

- **Org role** and **project role** are unchanged: `resolveProjectRole` already returns a
  max-wins base project role `R_p` across direct `project_members`, group, org, creator, and
  platform sources (`auth-worker/src/services/project-permissions.ts`). The ladder is the
  canonical 7-rung scheme in `src/lib/frontier/roles.ts` (Viewer 100 … Project Lead 500,
  Maintainer 600, Owner 700).
- **Lane role** is new: a grant of a **role level** to a `(project, user, lane)` triple. Lane
  grants **carry a level** — the owner's phrase was "lane-specific permission *levels*," so a
  member can be, e.g., a Reviewer on French and a Contributor on Swahili.

**Access to a lane `L`:**

```
canAccessLane(user, L):
  R_p = resolveProjectRole(user, project)      // existing max-wins
  if R_p >= ROLE.MAINTAINER (600):  return true       // cascade: 600+ sees every lane
  if grant(project, user, L) exists: return true       // explicit grant
  return false                                         // below 600, no grant ⇒ nothing
```

**Effective role *inside* an accessible lane `L`** (what the user may *do* there):

```
effectiveRoleInLane(user, L):
  R_p = resolveProjectRole(user, project)
  R_L = grant(project, user, L)?.level ?? -∞
  return max(R_p, R_L)      // a grant only ever ADDS capability, never subtracts
```

Rationale for `max`: a grant must never silently *demote* someone (a project Contributor
granted "access" to French should still be able to contribute there), but a grant *can* elevate
within a lane (make a project Viewer a lane Reviewer). This also means the existing role-floor
gate in `authorize()` composes cleanly: the role used for a lane-addressable event in `L`
becomes `effectiveRoleInLane`, and every non-lane-addressable action keeps using `R_p`.

### 1.2 What "no access" degrades to

A below-600 member with zero grants is the common translator case at rest before staffing. The
whole app must degrade gracefully for them, not error:

- Lane-addressable **reads** return their granted lanes only (empty set ⇒ source-only view;
  see §3 — source is never gated).
- Lane-addressable **writes** are refused by the write wall (§4).
- Lane **metadata** (names, count) shows only granted lanes (§2).
- Project-level, non-lane surfaces (project name, membership of *themselves*, comments if left
  ungated) still work at `R_p`.

### 1.3 Why grants carry a level (and the alternative rejected)

The binary alternative — a grant is just "access," and `R_p` alone decides capability — is
simpler but cannot express "make this translator a *reviewer* of only the French lane," which
is a real request implicit in AQU-1026 (per-lane PMs/maintainers/contributors). Since the owner
explicitly said "levels," grants carry a level. Cost: the migration and the composition rule
above must be exactly right, and the members UI grows a per-lane role picker (it already has a
per-lane scope editor — `MemberLaneScopeEditor` / `StaffLanePopover` — so this is an evolution,
not a new surface).

---

## 2. Metadata isolation — the new wall

This is the sharpest new requirement and has **no** precedent in the current codebase: today the
full lane registry is handed to every member.

### 2.1 The visible-lane set

Define one authority, mirroring the read-wall draft's `resolveReadLanes` but grant-driven and
now also governing metadata:

```ts
/** null = all lanes (600+/platform). A Set is the exact visible set (may be empty). */
export type VisibleLanes = ReadonlySet<string> | null

export async function resolveVisibleLanes(
  claims: SyncTokenClaims,      // carries R_p and the lane grants (§4)
  projectTargetLanes: string[], // the full registry, for the 600+/null short-circuit
): VisibleLanes
```

Resolution order (all cheap; no per-lane DB round trip because grants ride the token, §4):

```
1. claims.src === 'platform'         -> null        (operator)
2. claims.role >= ROLE.MAINTAINER    -> null        (600+ cascade)
3. grants present                    -> Set(granted lane tags)
4. otherwise                         -> ∅ (empty set)
```

Note step 4 is the inversion: **empty, not null.** Under the old model no-scopes meant `null`
(everything); here no-grants means the empty set (nothing).

### 2.2 Metadata-leak inventory (paths that expose lane *names* or *counts*)

Every one of these must filter its lane list through `resolveVisibleLanes` (or its auth-worker
twin) and derive any count from the *filtered* list. This is additive to the read-wall draft's
content inventory.

| # | File | What it exposes | Fix |
|---|---|---|---|
| M1 | `src/lib/sync/project-settings.ts` → `targetLanes` / `archivedLanes` (server response for `GET /projects/:id/settings`, `auth-worker/src/routes/projects.ts` #47 in the read-wall doc) | The **entire lane registry** to every member; the source of truth the whole client reads via `useProject`'s settings overlay | Filter the returned `targetLanes`/`archivedLanes` to the caller's visible set at the route boundary. This is the highest-leverage fix — most client surfaces derive from it. |
| M2 | `sync-worker/src/external/discovery-route.ts` (#36) | Advertises the `targetLanes` registry to Agent API callers | Filter to the token's visible set |
| M3 | `auth-worker/src/services/org-permissions.ts` → `fetchPortfolioLanes` / `getOrgPortfolio(s)` (#41) | Per-lane totals for **every project in the org**, plus the registered-lane union — a count/name leak across the whole org | Per-project visible-set filter inside the org-wide query (the hard part, same as read-wall slice 7) |
| M4 | `src/components/org/OverviewLaneTable.tsx` | Renders one row per lane with names + progress | Consumes M1's filtered registry; verify it renders nothing for lanes not in the set, and that "N lanes" counts the filtered rows |
| M5 | `src/components/org/LaneChips.tsx`, `src/components/org/ProjectLaneSubRows.tsx` | Lane name chips / sub-rows on org home | Same — consume filtered registry |
| M6 | The editor lane switcher (`EditorTable` lane switcher, `LaneCombobox`) | Lists selectable lanes | Options come from the visible set; §6 |
| M7 | `settings.targetLanes` cached client-side (IDB `project-index`, read-wall #50) | Full registry persisted on disk | `grantsVersion` cache-identity component (§5), same mechanism as the content-cache purge |
| M8 | Any "n lanes" badge / count derived from `targetLanes.length` on the client | Count leak even if names hidden | Derive from filtered registry; audit for `.length` on the raw registry |

**Load-bearing subtlety:** because so much of the client derives lane names from the single
settings-overlay registry (M1), filtering *that one response* per-caller closes most of the
metadata wall in one place. The exceptions are the org-portfolio (M3, a different worker and a
cross-project aggregate) and anything that counts lanes server-side independently.

### 2.3 The "count" requirement specifically

Hiding names but leaking count ("you have access to 1 of 5 lanes") still discloses that other
lanes exist, which the owner explicitly ruled out. So: **no cross-lane count may be returned to
a below-600 member.** Concretely — M3's union count, any `targetLanes.length` sent to the
client, and any "x/y lanes complete" rollup must be computed over the visible set only. Aggregate
rollups that sum content across lanes (read-wall §4.9 — `files` scalar counters,
`file_section_progress` sums) are a *content-inference* channel, but they also implicitly reveal
that other lanes exist; under this stricter requirement they must be served lane-scoped to
below-600 members rather than as cross-lane sums (the read-wall draft left this optional; the
metadata requirement makes it mandatory for the count dimension).

---

## 3. Content read wall — unchanged mechanism, new input

The read-wall draft's recommendation stands verbatim, with two substitutions:

- The authority is `resolveVisibleLanes` (grant-driven) instead of `resolveReadLanes`
  (scope+setting-driven). Same call site, same `LaneScopedRead` brand, same ESLint guard, same
  two enforcement points (SQL predicate + DO connection).
- `laneReadPredicate(visible, col)` still **always passes source rows** (`side = 'source'`),
  the AQU-538 shared-source invariant. Empty visible set ⇒ predicate matches only source rows,
  which is exactly the correct degraded view for an ungranted member.

Everything in the read-wall draft's §1 inventory (51 paths, 41 lane-bearing), §2 choke-point
analysis, and §5 slices applies. The only deletions are its §3 (the setting — gone) and the
bulk of its §4.1 (the `''` param hazard — gone with AQU-1240, §7 here).

---

## 4. Schema + write-wall changes

### 4.1 The grant table (replaces `kind='lane'` scopes)

Today (`db/postgres/schema.sql:1013`):

```sql
CREATE TABLE project_member_scopes (
  project_id TEXT, user_id BIGINT,
  kind TEXT CHECK (kind IN ('lane','file')), value TEXT,
  created_by TEXT, created_at BIGINT,
  PRIMARY KEY (project_id, user_id, kind, value)
);
```

Proposed:

```sql
-- Migration 00NN: per-lane role grants (AQU-730). Replaces kind='lane' scopes.
CREATE TABLE project_member_lane_roles (
  project_id TEXT   NOT NULL,
  user_id    BIGINT NOT NULL,
  lane       TEXT   NOT NULL,          -- explicit lane tag; post-AQU-1240 never ''
  role_level INTEGER NOT NULL,         -- the lane-specific level (§1.1)
  granted_by BIGINT,
  granted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, user_id, lane)
);
```

Decisions:
- **One row per (project, user, lane)** with a level, vs. the old (…, kind, value) with no
  level. `kind='file'` scopes are **out of scope for this change** — they stay in
  `project_member_scopes`, and file-scope read/write gating is unchanged. (Folding file scopes
  into a leveled model is a coherent follow-up; not now.)
- **`role_level` not a boolean** because grants carry levels (§1.3).
- Keep `project_member_scopes` for `kind='file'`; a later migration can drop its `kind='lane'`
  rows once the grant table is authoritative and the write wall reads it.

### 4.2 Token claim

`signSyncTokenWithRole` (`auth-worker/src/services/sync-token-mint.ts`) currently loads scope
rows into a `scopes` claim, omitted when empty. Replace the lane half with a `laneGrants` claim:

```ts
// laneGrants: [{ lane, level }], omitted entirely when the user has no lane grants.
const grantRows = await env.AQUILLA_PG.prepare(
  "SELECT lane, role_level FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? ORDER BY lane",
).bind(projectId, user.id).all()
```

Grants ride the token (like scopes do today), so both walls resolve without a per-request DB
round trip. The 15-minute TTL bounds staleness on a grant change exactly as it bounds a scope
change today; the existing `POST /__member-role-changed` DO hook is extended to carry grant
changes so a live socket updates in place (read-wall §3.3, point B). **Deliberately in the
token, unlike the old `laneReadIsolation` *setting*** — a setting flip needed to be instant, but
a grant change is already a deliberate staffing action with the same latency profile as today's
scope edits.

### 4.3 Write wall (`sync-worker/src/events/authorize.ts`)

`enforceScopes` today reads the `scopes` claim and checks lane membership for `SCOPE_GATED_KINDS`.
Rewrite it to read `laneGrants`:

- For a scope-gated event in lane `L`: require `claims.role >= 600` **or** a grant for `L`, and
  then check `effectiveRoleInLane(L) >= requiredRoleFor(kind)`.
- Absent `laneGrants` + role < 600 ⇒ **refuse** every scope-gated (lane-addressable) write.
  This is the inversion: today an absent claim means unscoped/allowed; now it means no lane
  access. **This is the single most dangerous change in the whole design** — it flips the
  default from allow to deny on the write path, so the migration (§5) MUST create grants for
  every existing below-600 member *before or atomically with* the code that reads grants, or
  every current translator is locked out on deploy.

### 4.4 Self-assign and the existing carve-outs

`canOpenAssignUi` / `canSubmitAssignment` (role-policy.ts) and the `assignment.create`
self-assign carve-out in `authorize()` are unaffected in mechanism, but "self-assign into a
lane" now additionally requires the member to have a grant for that lane (they cannot self-serve
work in a lane they can't access). Add that check to the carve-out.

---

## 5. Migration — the dangerous part

**Goal: nobody loses access on deploy.** Today a below-600 member with no scope rows can write
to *all* lanes; under the new model they'd have none. The migration must preserve current
effective access, then let isolation apply only to *future* lanes.

Ordering constraint (hard): **AQU-1240 (name every lane, remove `''`) lands first**, so grants
reference real lane tags and never `''`. If the two must interleave, the grant migration keys
off the post-1240 lane registry.

Migration steps (idempotent; keyed on `(project,user,lane)`):

1. **Create `project_member_lane_roles`.**
2. **Convert existing lane scopes.** For each `project_member_scopes` row with `kind='lane'`,
   insert `(project, user, lane, level = that member's current project role_level)`. A scoped
   member's capability in their scoped lane today *is* their project role, so this preserves it.
3. **Preserve currently-unscoped below-600 members.** For each below-600 project member with
   **no** lane scope rows (today = "all lanes"), insert a grant for **every current lane** of
   the project at their project role_level. **← POLICY FORK, flagged as open question 1.**
   Recommended: yes — silently stripping existing translators' access is the worse failure. New
   lanes added *after* migration get no auto-grant, so isolation applies going forward.
4. **600+ members:** no grants (cascade covers them).
5. **Dry-run assertion:** for a sample of projects, `effectiveRoleInLane` under the new model
   equals today's effective capability for every (member, lane) pair. Zero regressions before
   the code that reads grants ships.

Reversibility: while `project_member_lane_roles` and the `kind='lane'` scope rows both exist,
rolling back the code restores the old behaviour. Drop the old lane scope rows only after the
grant table has been authoritative in production for a bake period.

Interaction with invites (AQU-528, schema.sql:207): the language-scoped invite flow currently
"auto-grants as `kind='lane'` project_member_scopes on accept." That accept path must be
repointed to write a `project_member_lane_roles` grant (at the invite's role) instead.

---

## 6. Lane switcher

Decision already recorded on AQU-730: a below-600 member may switch **only among their granted
lanes**; 600+ among all. `canSwitchLanes` (role-policy.ts, today `>= 600` only) becomes:

```
canSwitchLanes(role, visibleLaneCount):
  role >= 600            -> true (all lanes)
  visibleLaneCount > 1   -> true (switch among granted lanes)
  otherwise              -> false (0–1 accessible lanes: static pill, no dropdown)
```

The switcher's options come from `resolveVisibleLanes`, so it structurally cannot offer a lane
the user can't enter — which also fixes the AQU-1029 "lands on a lane you can't reach" stranding:
the initial active lane is chosen from the visible set, never the (now-removed) default lane.
The existing switcher UI (`EditorTable` + `LaneCombobox`, shipped in AQU-608) is reused;
`EditorTable.laneSwitcher.test.tsx` (which pins "contributor has no switcher") must be updated
to the grant-based rule.

---

## 7. What AQU-1240 (no default lane) collapses

The read-wall draft spent its longest edge-case section (§4.1) on the falsy-`''` tri-state param
hazard, plus §4.10 on `{''}`-vs-`null` ETag composition. With AQU-1240:

- Every lane is an explicit, non-empty tag. `''` is illegal for target rows. So there is no
  falsy lane to collapse `?lane=` into "all lanes," and the tri-state param problem **goes away**
  — a lane param is either a real tag or absent.
- `laneReadPredicate` no longer needs the `row.target_lang ?? ''` care; source rows are
  identified by `side='source'`, not by `target_lang=''`.
- The grant table never stores `''`; the visible set never contains `''`.
- **Survives:** source rows are still always visible regardless of grants (shared-source
  invariant); the `{visible}`-in-ETag requirement survives (two callers with different visible
  sets must not collide on a 304), but the specific `{''}`-vs-`null` collision case is gone.

This is why the ordering in §5 matters: doing this permissions work *before* AQU-1240 would mean
building the `''` tri-state handling and then deleting it.

---

## 8. Sliced implementation plan

Builds on the read-wall draft's slices; re-sequenced for the grant substrate. **S** ≈ <1 day,
**M** ≈ 1–3 days, **L** ≈ week+.

| # | Slice | Size | Risk | Depends on |
|---|---|---|---|---|
| 0 | **Characterisation tests** pinning today's behaviour: below-600 member with/without scopes reads+writes all lanes; full registry returned to everyone. Becomes the regression baseline. | S | — | — |
| 1 | **`project_member_lane_roles` table + migration (steps 1–4) + dry-run assertion (step 5).** No code reads it yet. Reversible. | M | **HIGH** | AQU-1240 lane-naming migration |
| 2 | **Mint `laneGrants` into the token**; keep reading old scopes in parallel (dual-read) so nothing breaks. | S | Med | 1 |
| 3 | **`resolveVisibleLanes` authority + `LaneScopedRead` brand + ESLint guard.** Unwired. Unit tests incl. empty-set and 600-cascade cases. | S | Low | 2 |
| 4 | **Write wall over grants** (`enforceScopes` → grant-based, `effectiveRoleInLane`). Flip default allow→deny. **Must ship after the migration has populated grants in prod.** | M | **HIGH** | 1, 2 |
| 5 | **Metadata wall — M1 first** (filter `targetLanes`/`archivedLanes` at the settings route). Closes most of §2 in one place. | M | Med | 3 |
| 6 | **Metadata wall — remainder:** discovery (M2), org portfolio (M3, the hard cross-project one), overview tables + counts (M4/M5/M8). | M | Med | 5 |
| 7 | **Content read wall — `cells-read-route` (the 80% path)** with the visible set in the ETag + chainCache key. (Read-wall slice 3, now grant-driven; the `''` tri-state work is *not* needed.) | M | **HIGH** | 3, 5 |
| 8 | **Content read wall — remaining lane-column reads** (search/export/progress/validators). Brand makes each a compile error until fixed. | M | Med | 7 |
| 9 | **Realtime / DO** — `ConnectionState.visibleLanes` at `/connect`; filter `event.applied.rows` + `presence.draft`; extend `__member-role-changed` for grant changes. | M | **HIGH** | 3 |
| 10 | **Client cache identity** — `grantsVersion` claim; fold into content + registry IDB keys; purge on mismatch. | S | Med | 2 |
| 11 | **auth-worker wall** — parallel resolver over `project_member_lane_roles`; apply to assignment/workload reads (#37–45). | M | Med | 3 |
| 12 | **Switcher + members UI** — grant-based `canSwitchLanes`; per-lane role picker in the members panel; repoint AQU-528 invite accept to write grants. | M | Med | 2 |
| 13 | **Lane-less tables + event-log reads** (read-wall slices 8–9) — audio/backtranslations/links/waivers get a lane column; `events` payload lane discriminator. | L | **HIGH** | 8 |
| 14 | **Drop `kind='lane'` scope rows** after grant table bakes. | S | Low | 4, 11 |

**Riskiest:** slice 1 (migration correctness — a wrong `effectiveRoleInLane` mapping either
locks people out or over-grants), slice 4 (allow→deny flip on the write path — sequencing against
the migration is everything), slice 7 & 9 (highest-traffic + cross-user-leak surfaces, same as
the read-wall draft).

---

## 9. Open questions for a human

1. **Preserve-access policy (§5 step 3).** Confirm existing below-600 members with no scopes get
   grants to **all current lanes** at migration (recommended), so nobody loses access; and that
   lanes added *after* migration are isolated (no auto-grant). This is the one policy fork with
   real blast radius.
2. **Grant level vs project role interaction (§1.1).** Confirm `effectiveRoleInLane = max(R_p,
   R_L)` (grants only elevate, never demote). Alternative: a lane grant is authoritative and can
   *cap* a member below their project role in that lane — more powerful, more surprising.
3. **Metadata for 500 (Project Lead).** 600+ cascades to all lanes. Do **Project Leads (500)**
   also see all lane names/counts (they're operational PMs and the PM-oversight spec says leads
   see all languages), or only granted lanes? Recommendation: 500+ sees all lane *metadata*
   (names/count) even if content follows grants — otherwise a lead can't staff a lane they can't
   see. This may argue for a metadata floor at 500 distinct from the content floor at 600.
4. **File scopes.** Left in `project_member_scopes`, unleveled, ungated on reads. Confirm out of
   scope for this change.
5. **Ordering vs AQU-1240.** Confirm the lane-naming migration lands before the grant migration
   (§5, §7).
6. **Comments / audio (read-wall §4.7).** Still ungated on reads in v1? Under strict metadata
   isolation, a comment quoting another lane's text is a content leak — revisit.
7. **Agent/external tokens.** An Agent API token inherits its operator's grants (recommended) —
   confirm; an agent reading a lane its operator can't is a bypass.

---

## 10. Reconciliation with prior specs

- `2026-07-11-project-data-model-decision.md`: shared-source invariant preserved (source always
  visible); `''`-default-lane wire convention is removed by AQU-1240, which this design assumes.
- `2026-07-14-pm-lane-oversight-design.md`: PM surfaces are cross-lane; PMs sit ≥ 500. Open
  question 3 decides whether the metadata floor is 500 or 600. If 500, the oversight spec's
  "leads see all languages" promise extends to metadata for free.
- `2026-09-09-lane-read-wall-design.md`: superseded on the permission substrate (scopes→grants)
  and the setting (removed); reused on inventory, choke point, brand, and DO enforcement.
- AQU-608 (switcher), AQU-1029 (stranding), AQU-528 (language-scoped invite): all fold in as
  noted in §6 and §5.
