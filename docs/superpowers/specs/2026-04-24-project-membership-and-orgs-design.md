# Project Membership & Flat Orgs — Design

**Date:** 2026-04-24
**Status:** Draft
**Scope:** Owners can directly add users to a project by username (no invite/accept dance). A flat organization layer lets org-level roles confer access to every project in the org. Project cards on the dashboard render an avatar stack of effective members. The existing link/PIN flow stays as the anonymous-reviewer path.

## Goals

- Direct add: a project owner/lead types a username and the user is immediately a member at a chosen role.
- Flat orgs: every Codex user has one personal organization; org members with `manager` or `owner` roles automatically have effective access to every project in that org. No nesting, no sub-teams.
- **Free use:** creating an org, creating projects, and adding users do **not** require a paid plan. Personal orgs are created without a Stripe customer; billing is layered on later (out of scope).
- Frontier-server is the source of truth. The web app calls REST endpoints and renders results; no client-side permission resolution.
- Dashboard project cards show an avatar stack for effective members (static — no online state).
- Three-legged stool preserved: a user can be in a project without being in its org (freelancer / marketplace pattern), or in an org without being on every individual project (default `member` role).
- Anonymous link/PIN flow unchanged.

## Non-Goals

- Online/presence indicators on dashboard cards (deferred; presence already works inside an open project via Yjs awareness).
- Email-based invites or pending invites for users who haven't signed up yet.
- Multi-org per user / org switcher / billing-owned orgs distinct from personal orgs.
- Hierarchical groups, sub-teams, or per-folder permissions.
- Org creation UI (orgs are lazy-created server-side on first need).
- Migrating existing projects whose `org_id IS NULL` (they continue to work via existing creator/`project_members` tiers; new projects always get an `org_id`).
- Email-based user lookup (matches `0012_drop_email_lookup.sql` direction).

## Current State

- **Schema** (frontier-server D1, `frontier-db-v2`):
  - `users(id, username UNIQUE, email UNIQUE, ...)` — users are case-sensitive on username (no `COLLATE NOCASE`); auth login compares with `username = ?`.
  - `organizations(id, name, stripe_customer_id NOT NULL UNIQUE, subscription_tier NOT NULL, owner_user_id, gitlab_group_id, ...)` — billing entity. **No `org_members` table exists today.**
  - `roles(level, name, description)` — populated with `100 viewer`, `200 commenter`, `300 reviewer`, `400 contributor`, `500 project_lead`, `600 maintainer`, `700 owner`.
  - `projects(id, name, gitlab_project_id, org_id NULLABLE, created_by, archived_at, archived_by, ...)`.
  - `project_members(project_id, user_id, role_level, granted_by, granted_at)` — composite PK `(project_id, user_id)`.
  - `project_invites(token, project_id, role_level, ...)` — link/PIN flow; unchanged by this design.

- **Permission resolution:** `resolveProjectRole(env, user, projectId)` in `src/services/project-permissions.ts` — three-tier cascade today:
  1. `project_members` row → that role (source `"override"`)
  2. `projects.created_by == user.id` → 700 (source `"creator"`)
  3. GitLab fallback via `/api/v4/projects/:id/members/all/:user_id` → mapped role (source `"gitlab"`)
  4. Null → caller returns 403.

- **Endpoints touching membership today:**
  - `GET /api/v2/projects` — lists projects where caller is `created_by` or has a `project_members` row (does **not** consult orgs).
  - `POST /api/v2/projects/:id/invites` — gated at role ≥ 500; mints a redeemable link token.
  - `POST /api/v2/projects/accept-invite` — joiner redeems token → inserts `project_members`.
  - `POST /api/v2/sync-token` — returns `{role: {level, name, source}}` for the caller on a specific project.
  - No "list members," no "add member by username," no user lookup, no org membership endpoints.

- **Client (`codex-web-app`):**
  - `SharePanel` ([src/components/SharePanel.tsx](../../src/components/SharePanel.tsx)) shows the link/PIN flow only; no member list.
  - `Dashboard` and `ProjectCard` show project metadata only; no avatars.
  - `PeerPresence` renders Yjs awareness for users currently inside an open file.
  - `useFileSync` consumes `sync-token`'s role response; no separate role fetch on the dashboard.

## Data Model

### Frontier-server D1 — migration 0016

```sql
-- Migration: 0016_org_members.sql
-- Description: Add membership table for organizations with role-level access.

CREATE TABLE org_members (
  org_id     INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role_level INTEGER NOT NULL,
  granted_by INTEGER,
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_level) REFERENCES roles(level),
  FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE INDEX idx_org_members_org ON org_members(org_id);
```

### Frontier-server D1 — migration 0017 (org auto-creation prerequisite)

`organizations.stripe_customer_id` is currently `NOT NULL UNIQUE`, which blocks lazy-creating a personal org without a Stripe customer. Two options:

- **(chosen) Make `stripe_customer_id` nullable.** Personal orgs created server-side without a Stripe customer use `NULL`. When the org is later promoted to a billing customer (Stripe checkout), the column is populated. Reflects the actual model: an org can exist for permission scoping before it's ever billed.
- **Reuse `users.stripe_customer_id`.** Rejected — couples user-level and org-level billing in a way that breaks if a user later owns multiple orgs.

```sql
-- Migration: 0017_orgs_stripe_optional.sql
-- Description: Permit organizations without a Stripe customer (lazy personal orgs).
-- SQLite does not support ALTER COLUMN; rebuild table.

CREATE TABLE organizations_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT,
  stripe_customer_id  TEXT UNIQUE,
  subscription_tier   TEXT NOT NULL DEFAULT 'free',
  owner_user_id       INTEGER NOT NULL,
  gitlab_group_id     INTEGER,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
INSERT INTO organizations_new SELECT * FROM organizations;
DROP TABLE organizations;
ALTER TABLE organizations_new RENAME TO organizations;
CREATE INDEX idx_organizations_owner ON organizations(owner_user_id);
```

### No client schema changes

Membership lists are fetched on demand and cached in React state (or a thin in-memory cache keyed on `projectId`/`orgId`). Nothing is persisted to IndexedDB. The stale `ProjectMember` type currently in the Y.Doc (local-only, never synced) is unused by this feature and stays untouched in this spec.

## Permission Resolution

Updated `resolveProjectRole` cascade — a new tier 3 inserted; existing tiers shift down:

```
1. project_members(project_id, user_id) → that role         source: "override"
2. projects.created_by == user.id        → 700              source: "creator"
3. org_members(project.org_id, user_id)  → that role        source: "org"     (NEW)
4. GitLab fallback                       → mapped role      source: "gitlab"
5. Null                                  → 403
```

Tier 3 is skipped when `project.org_id IS NULL`. Cascade order means a project-level override (tier 1) always wins over an org-level role (tier 3), so demoting a specific user on a specific project still works even if they're an org `manager`.

`GET /api/v2/projects` is updated to mirror the cascade. The new query union: projects where `created_by = user.id` ∪ projects with a `project_members` row for the user ∪ projects whose `org_id` appears in `org_members(user_id = user.id)`. GitLab-fallback projects are not surfaced on the dashboard listing (out of scope; matches today's behaviour).

## Endpoints

All paths under `/api/v2`. All require auth unless noted.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| `GET` | `/users/lookup?username=X` | any auth | Resolve username → `{id, username}`. 404 on miss. Case-sensitive (matches existing auth comparisons). No rate limit in v1; revisit if abused. |
| `GET` | `/projects/:id/members` | role ≥ 100 on project | List effective members: rows from `project_members(project_id)` ∪ rows from `org_members(project.org_id)`. Returns `[{userId, username, role: {level, name, source: "override" \| "creator" \| "org"}}]`. The project creator is always included as `source: "creator"` even without a `project_members` row. |
| `POST` | `/projects/:id/members` | role ≥ 500 on project | Body `{username, role}`. Looks up user via username; 404 if missing. `role ≤ caller's role`. Inserts/upserts `project_members(project_id, user_id, role_level, granted_by=caller)`. |
| `DELETE` | `/projects/:id/members/:userId` | role ≥ 600 on project | Removes the `project_members` row. Returns 409 if the user has access **only** via `org_members` (no `project_members` row to delete) — body hints to remove from org instead. |
| `GET` | `/orgs/me` | any auth | Returns `{id, name, role}` for the caller's owned org. **Lazy-creates** if `organizations.owner_user_id == user.id` yields no row: inserts `organizations(name="<username>'s workspace", owner_user_id=user.id, stripe_customer_id=NULL, subscription_tier='free')` and `org_members(org_id, user.id, 700)`. |
| `GET` | `/orgs/:id/members` | org member | List `[{userId, username, role: {level, name}}]`. The owner (`organizations.owner_user_id`) is always included even if no `org_members` row exists, as `role.level=700`. |
| `POST` | `/orgs/:id/members` | org owner (level 700) | Body `{username, role}`. Lookup + upsert into `org_members`. `role ≤ 700`. Self-add rejected (already owner). |
| `DELETE` | `/orgs/:id/members/:userId` | org owner | Removes `org_members` row only. **Direct `project_members` rows for that user are not touched** — by design. The client surfaces them so the actor can decide. Owner cannot remove self (transfer flow out of scope). |
| `GET` | `/orgs/:id/members/:userId/projects` | org owner | Returns the list of projects in this org where the user has a direct `project_members` row: `{projects: [{id, name, role: {level, name}}]}`. Used by the "remove from org" confirmation flow to populate the project list. |

### Response shapes

```ts
// GET /users/lookup
{ id: number; username: string }

// GET /projects/:id/members
{
  members: Array<{
    userId: number
    username: string
    role: {
      level: number
      name: "viewer" | "commenter" | "reviewer" | "contributor" | "project_lead" | "maintainer" | "owner"
      source: "override" | "creator" | "org"
    }
  }>
}

// GET /orgs/me
{ id: number; name: string; role: { level: number; name: string } }

// GET /orgs/:id/members
{
  members: Array<{
    userId: number
    username: string
    role: { level: number; name: string }
  }>
}

// GET /orgs/:id/members/:userId/projects
{
  projects: Array<{
    id: string
    name: string
    role: { level: number; name: string }
  }>
}
```

### Error shape (consistent with existing routes)

```ts
{ error: string }
```

## Client UX

### Dashboard — `ProjectCard` avatar stack

[src/components/ProjectCard.tsx](../../src/components/ProjectCard.tsx) gains an avatar row. On mount, the card calls `useProjectMembers(projectId)`. Renders up to 4 initials avatars overlapping (same color hash as `PeerPresence`); a `+N` chip appears when there are more. Hover on a chip reveals a tooltip listing usernames + role names. No online/offline state in v1 — all avatars render at full opacity.

To avoid a thundering herd of `/projects/:id/members` calls on dashboard load, the dashboard issues a single batched call: `GET /api/v2/projects/members?ids=p1,p2,p3` returning a map. (Server endpoint added; same gating applied per project; results filtered to projects the caller can read.) If batching adds complexity to the server, fall back to per-card fetches gated by an in-memory cache keyed by `projectId`. Decision deferred to the implementation plan.

### Share modal — Members tab

[src/components/SharePanel.tsx](../../src/components/SharePanel.tsx) gains a tab strip with **Members** (default) and **Invite link** (existing flow). The Members tab:

- Lists effective members from `GET /projects/:id/members`. Each row: avatar + username + role select (caller-permitted levels only) + Remove button.
- Members with `source === "org"` show a small "via org" chip and no Remove button. (Tooltip: "Remove from org to revoke.")
- Members with `source === "creator"` show "Owner" with no Remove.
- "Add member" form: username text input + role select + Add button. On Add: calls `GET /users/lookup?username=…` first; if 404, inline error "No user with that username." If found, calls `POST /projects/:id/members`.
- Role changes call `POST /projects/:id/members` (upsert).

### Org Settings page

New route — exact mount point depends on existing router; minimum: a settings entry "Organization" reachable from the dashboard top bar or user menu. Renders:

- Org name displayed read-only in v1. Rename UX (and the corresponding `PUT /orgs/:id`) is a follow-up.
- Member list from `GET /orgs/:id/members`.
- "Add member" form mirroring the share modal's UX.
- Role select per row (owner-permitted only).
- Remove per row.

### Remove-from-org confirmation flow

When the user clicks Remove on an org member, the UI does **not** call `DELETE` immediately. Instead it opens a confirmation modal:

1. Calls `GET /orgs/:id/members/:userId/projects` to list direct project memberships.
2. Modal copy: **"Remove Anna from the foundation?"** — body explains: removing from the org revokes her org-wide access, but she will keep direct access to any project she's been added to individually. The list of those projects is shown with a checkbox per row (defaulted to **unchecked** — i.e. opt-in to also remove direct memberships).
3. Confirm button label adapts: "Remove from org" if no boxes checked; "Remove from org and N projects" otherwise.
4. On confirm, the client issues `DELETE /orgs/:id/members/:userId` followed by `DELETE /projects/:projectId/members/:userId` for each checked project. Failures are surfaced row-by-row; partial success is acceptable (the modal stays open with an error toast and the still-removable rows can be retried).

This keeps the server endpoints orthogonal (one resource per endpoint) and puts the multi-step decision on the client, where the UX lives.

### New client modules

- [src/lib/frontier/members.ts](../../src/lib/frontier/members.ts) — typed wrappers for the nine new endpoints.
- [src/hooks/useProjectMembers.ts](../../src/hooks/useProjectMembers.ts) — `useProjectMembers(projectId)` returning `{members, isLoading, error, addMember, removeMember, changeRole}`. Optimistic updates; revalidate on mutation response.
- [src/hooks/useOrg.ts](../../src/hooks/useOrg.ts) — `useOrg()` returning the caller's org (`GET /orgs/me`) and `useOrgMembers(orgId)`.

## Walkthrough — Wendy / Anna / Clayton / Valerie / Amir

1. **Wendy signs up.** First dashboard load → `GET /orgs/me` → server lazy-creates "Wendy's workspace" with Wendy as `owner_user_id`. Returns `{id: 42, name: "Wendy's workspace", role: {level: 700, name: "owner"}}`.
2. **Wendy creates project P1.** Server inserts `projects(id, name, org_id=42, created_by=wendy_id, ...)`. Cascade tier 2 (creator) gives Wendy 700 on P1.
3. **Wendy opens Org Settings → adds Anna as `maintainer` (600).** UI calls `GET /users/lookup?username=anna` → `{id, username}`. Then `POST /orgs/42/members {username:"anna", role:600}` → server inserts `org_members(42, anna_id, 600)`.
4. **Anna logs in.** Dashboard `GET /projects` returns P1 (Anna has org_members row at 600 ≥ 100; project.org_id=42 matches). Cascade tier 3 resolves Anna's role on P1 as 600.
5. **Wendy creates P2 … P600.** All get `org_id=42`. Anna automatically sees all of them on her dashboard with role 600.
6. **Anna opens project P3 → Members tab → adds Clayton (`contributor`, 400).** `POST /projects/P3/members {username:"clayton", role:400}` → `project_members(P3, clayton_id, 400)`. Cascade tier 1 (override) resolves Clayton's role on P3 as 400.
7. **Anna adds Valerie to P5 and P3.** Two `project_members` rows.
8. **Anna adds Amir to P10.** One `project_members` row.
9. **Clayton's dashboard.** `GET /projects` returns only P3, P5 (no org_members row, only project_members rows for those two).
10. **Anna lowers Clayton on P3 to `commenter`.** `POST /projects/P3/members {username:"clayton", role:200}` upserts. Override still wins; even if Clayton were org_member 600, the project-level 200 would apply.
11. **Wendy hires a freelancer Quinn (not in the org) for P7.** Anna runs the same `POST /projects/P7/members {username:"quinn", role:300}`. Quinn never appears in `org_members(42)`. Quinn sees only P7. Three-legged stool intact.
12. **Anna removes Clayton from P3.** `DELETE /projects/P3/members/{clayton_id}`. Returns 200. Clayton loses access to P3.
13. **Wendy tries to remove Anna from P3 directly.** Anna has no `project_members(P3, ...)` row — only `org_members(42, anna_id, 600)`. Server returns 409 with hint "Remove from org to revoke."

## Risks & Open Questions

1. **`organizations.stripe_customer_id` was `NOT NULL UNIQUE`.** Migration 0017 makes it nullable. This is a schema change to a billing-adjacent table — needs review with whoever owns Stripe sync (`src/services/stripeSync.ts`) to ensure `NULL` doesn't break any existing query. Search for `stripe_customer_id IS NOT NULL` style guards before merging.
2. **Existing `organizations` rows.** Today's data may have orgs created via Stripe webhook flows. They keep their `stripe_customer_id`. The migration is additive (relax NOT NULL); no data backfill needed.
3. **Existing projects with `org_id IS NULL`.** Continue to work — tier 3 query `org_members(project.org_id, user_id)` returns no rows when `org_id IS NULL`. No regression. New projects always get `org_id` (the create-project endpoint must be updated to derive it from the caller's `GET /orgs/me`).
4. **Owner of an org cannot remove themselves.** Org ownership transfer is out of scope. If Wendy needs to leave the foundation, that's a manual support request for v1.
5. **Username case-sensitivity.** Lookup uses `username = ?` to match existing auth login behavior. Mismatched case → 404. Documented in the lookup endpoint description; may revisit if it causes UX friction.
6. **Self-grant rejection.** `POST /projects/:id/members` with `username == caller.username` is rejected (400) — caller already has a role via cascade. Same for `POST /orgs/:id/members`.
7. **Role downgrade by caller of equal role.** Caller at level 600 cannot remove or demote another member at 600. Endpoint enforces strict `>` for write actions on equal-level peers (matches GitHub-style behavior).
8. **Rate limiting on `/users/lookup`.** Out of scope for v1; in B2B with low session volume, abuse risk is minimal. Add Cloudflare rate limit rule if signups grow.
9. **Dashboard avatar batch endpoint.** Whether to ship a batched `GET /projects/members?ids=…` or per-card fetches is deferred to the implementation plan. Either works; batched is faster for the 600-project dashboard case.
10. **GitLab-only members.** Today's tier-4 GitLab fallback grants access at request time but doesn't materialize anything in `project_members`. Such users do **not** appear in `GET /projects/:id/members`. Acceptable for v1 — the in-app "members" surface is for managed members. Doc this clearly so reviewers don't expect to see a GitLab-only collaborator listed.
