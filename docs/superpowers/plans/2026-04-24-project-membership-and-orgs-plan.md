# Project Membership & Flat Orgs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship direct add-by-username project membership, a flat org layer with role inheritance, and dashboard avatar stacks — backed by frontier-server (D1, Hono) with the codex-web-app as a thin UI consumer.

**Architecture:** Frontier-server gains an `org_members` table; `resolveProjectRole` adds an `org` tier between `creator` and `gitlab`. Eight new server endpoints power member/org CRUD plus user lookup. The web app gains a `useProjectMembers` + `useOrg` hook layer, an avatar stack on `ProjectCard`, a Members tab in `SharePanel`, and an Org Settings page with a remove-from-org confirmation flow.

**Tech Stack:** Cloudflare Workers + Hono + D1 + Vitest (server); React + TypeScript + Vite + Vitest + React Router + shadcn/ui (client).

**Repos touched:**
- `/Users/ryderwishart/frontierrnd/frontier-server/cloudflare/` — server
- `/Users/ryderwishart/prototypes/codex-web-app/` — client

**Spec:** [`docs/superpowers/specs/2026-04-24-project-membership-and-orgs-design.md`](../specs/2026-04-24-project-membership-and-orgs-design.md)

---

## File Structure

### Frontier-server (`/Users/ryderwishart/frontierrnd/frontier-server/cloudflare/`)

| Path | Status | Responsibility |
|---|---|---|
| `migrations/0016_org_members.sql` | create | New org_members table + indexes |
| `migrations/0017_orgs_stripe_optional.sql` | create | Relax `organizations.stripe_customer_id` to nullable |
| `src/services/org-permissions.ts` | create | `getOrCreateUserOrg`, `lookupOrgMember`, `listOrgMembersWithUsers`, `listOrgProjectMemberships` |
| `src/services/user-lookup.ts` | create | `lookupUserByUsername` (single source of truth for resolving username → user row) |
| `src/services/project-permissions.ts` | modify | Add tier-3 `org_members` lookup in `resolveProjectRoleInternal` |
| `src/routes/users.ts` | create | `GET /api/v2/users/lookup` |
| `src/routes/orgs.ts` | create | `GET /orgs/me`, members CRUD, member-projects |
| `src/routes/projects.ts` | modify | Add members CRUD endpoints; update `GET /` listing query; ensure project creation sets `org_id` |
| `src/index.ts` | modify | Register new route modules |
| `src/tests/users.test.ts` | create | User lookup endpoint tests |
| `src/tests/orgs.test.ts` | create | Org endpoint tests |
| `src/tests/project-members.test.ts` | create | Project members endpoint tests |
| `src/tests/project-permissions.test.ts` | create | Cascade unit tests (tier 3 added) |

### Codex-web-app (`/Users/ryderwishart/prototypes/codex-web-app/`)

| Path | Status | Responsibility |
|---|---|---|
| `src/lib/frontier/members.ts` | create | Typed wrappers: `lookupUser`, `listProjectMembers`, `addProjectMember`, `removeProjectMember`, `changeProjectMemberRole` |
| `src/lib/frontier/orgs.ts` | create | Typed wrappers: `getOrCreateMyOrg`, `listOrgMembers`, `addOrgMember`, `removeOrgMember`, `listOrgMemberProjects` |
| `src/hooks/useProjectMembers.ts` | create | List + mutate effective members for a project |
| `src/hooks/useOrg.ts` | create | `useOrg`, `useOrgMembers` |
| `src/components/MembershipAvatars.tsx` | create | Reusable avatar stack (initials + color-hash, +N overflow) |
| `src/components/ProjectCard.tsx` | modify | Insert `<MembershipAvatars>` |
| `src/components/MembersPanel.tsx` | create | Reusable list + add-form + role-select + remove (used by SharePanel and OrgSettings) |
| `src/components/SharePanel.tsx` | modify | Tabs: Members (default) / Invite link |
| `src/components/RemoveOrgMemberDialog.tsx` | create | Confirmation flow with project checkbox list |
| `src/pages/OrgSettings.tsx` | create | Org settings page; mounts `<MembersPanel>` against org endpoints |
| `src/App.tsx` (or wherever routes are declared) | modify | Add `/settings/org` route |
| `src/components/Dashboard.tsx` | modify | Add nav link to Org Settings |
| `src/lib/frontier/members.test.ts` | create | Wrapper tests |
| `src/lib/frontier/orgs.test.ts` | create | Wrapper tests |
| `src/components/MembershipAvatars.test.tsx` | create | Component test |

---

## Pre-flight

- [ ] **Step 0.1: Verify both repos build cleanly on `main` before changes.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npm run type-check && npm test -- --run
```

Expected: typecheck OK; all existing tests pass.

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
npm run typecheck 2>/dev/null || npx tsc --noEmit
npm test -- --run 2>/dev/null || npx vitest run
```

Expected: typecheck OK; all existing tests pass. If typecheck fails on `main`, stop and report — don't continue on a broken baseline.

---

## Phase 1 — Server schema and permission cascade

### Task 1: Migration 0016 — `org_members` table

**Files:**
- Create: `migrations/0016_org_members.sql`

- [ ] **Step 1.1: Create the migration file.**

```sql
-- Migration: 0016_org_members.sql
-- Description: Add membership table for organizations with role-level access.
--
-- An org_members row grants the user that role on every project belonging to
-- the org (project.org_id == org_members.org_id), via tier 3 of
-- resolveProjectRole. Reuses the existing roles(level) ladder.

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

- [ ] **Step 1.2: Apply the migration locally.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npm run db:migrate:local
```

Expected: prints "🚣 Migrations applied". Migration 0016 listed.

- [ ] **Step 1.3: Verify the table exists.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server
wrangler d1 execute frontier-db-v2 --local --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='org_members';"
```

Expected: one row, `org_members`.

- [ ] **Step 1.4: Commit.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
git add migrations/0016_org_members.sql
git commit -m "feat(db): add org_members table for flat-org membership

Tier-3 input for resolveProjectRole — an org_members row at level N
gives the user that role on every project where projects.org_id matches."
```

---

### Task 2: Migration 0017 — `organizations.stripe_customer_id` nullable

**Files:**
- Create: `migrations/0017_orgs_stripe_optional.sql`

- [ ] **Step 2.1: Verify nothing in `src/services/stripeSync.ts` requires `stripe_customer_id` to be non-null.**

Run: `grep -n "stripe_customer_id" src/services/stripeSync.ts src/routes/payments.ts`

Read each match. Confirm none asserts NOT NULL. If a query has `WHERE stripe_customer_id IS NOT NULL` that's fine (still works). If something inserts orgs and would now produce NULL where it didn't before, flag and stop.

- [ ] **Step 2.2: Write the migration.**

```sql
-- Migration: 0017_orgs_stripe_optional.sql
-- Description: Permit organizations without a Stripe customer (lazy personal
-- orgs created server-side on first /orgs/me hit). SQLite cannot ALTER a
-- column to drop NOT NULL — table rebuild is the canonical workaround.

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

INSERT INTO organizations_new (
  id, name, stripe_customer_id, subscription_tier,
  owner_user_id, gitlab_group_id, created_at, updated_at
)
SELECT
  id, name, stripe_customer_id, subscription_tier,
  owner_user_id, gitlab_group_id, created_at, updated_at
FROM organizations;

DROP TABLE organizations;
ALTER TABLE organizations_new RENAME TO organizations;

CREATE INDEX idx_organizations_owner ON organizations(owner_user_id);
```

- [ ] **Step 2.3: Apply locally and verify.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npm run db:migrate:local
cd /Users/ryderwishart/frontierrnd/frontier-server
wrangler d1 execute frontier-db-v2 --local --command \
  "INSERT INTO organizations (name, owner_user_id) VALUES ('test-no-stripe', 1);"
```

Expected: insert succeeds (no NOT NULL violation).

- [ ] **Step 2.4: Clean up the test row and commit.**

```bash
wrangler d1 execute frontier-db-v2 --local --command \
  "DELETE FROM organizations WHERE name='test-no-stripe';"
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
git add migrations/0017_orgs_stripe_optional.sql
git commit -m "feat(db): allow organizations without a stripe customer

Lazy personal orgs are created on demand for any signed-in user via
GET /orgs/me. Billing wiring stays orthogonal — populated on Stripe
checkout, not at org creation."
```

---

### Task 3: User lookup service

**Files:**
- Create: `src/services/user-lookup.ts`

- [ ] **Step 3.1: Write the failing test.**

Create `src/tests/user-lookup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookupUserByUsername } from "../services/user-lookup";
import type { Env } from "../types";
import { createMockEnv } from "./setup";

describe("lookupUserByUsername", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns user row when username matches exactly", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 7, username: "anna" }),
      }),
    }));
    const result = await lookupUserByUsername(env, "anna");
    expect(result).toEqual({ id: 7, username: "anna" });
  });

  it("returns null when no user matches", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
    }));
    const result = await lookupUserByUsername(env, "ghost");
    expect(result).toBeNull();
  });

  it("uses case-sensitive comparison (matches existing auth)", async () => {
    const prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
    });
    (env.DB.prepare as any).mockImplementation(prepare);
    await lookupUserByUsername(env, "Anna");
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toMatch(/username\s*=\s*\?/);
    expect(sql).not.toMatch(/LOWER|COLLATE NOCASE/i);
  });
});
```

- [ ] **Step 3.2: Run, expect failure.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npx vitest run src/tests/user-lookup.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement.**

Create `src/services/user-lookup.ts`:

```ts
import type { Env } from "../types";

export interface LookedUpUser {
  id: number;
  username: string;
}

/**
 * Resolve a username to a user id. Case-sensitive on purpose — matches the
 * existing auth login path (`SELECT * FROM users WHERE username = ?`). A miss
 * returns null; callers translate that into a 404 at the HTTP layer.
 */
export async function lookupUserByUsername(
  env: Env,
  username: string
): Promise<LookedUpUser | null> {
  const row = (await env.DB.prepare(
    "SELECT id, username FROM users WHERE username = ?"
  )
    .bind(username)
    .first()) as { id: number; username: string } | null;
  return row;
}
```

- [ ] **Step 3.4: Run, expect pass.**

```bash
npx vitest run src/tests/user-lookup.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3.5: Commit.**

```bash
git add src/services/user-lookup.ts src/tests/user-lookup.test.ts
git commit -m "feat(server): add user-lookup service for username resolution"
```

---

### Task 4: `GET /api/v2/users/lookup` endpoint

**Files:**
- Create: `src/routes/users.ts`
- Modify: `src/index.ts`

- [ ] **Step 4.1: Write the failing test.**

Create `src/tests/users.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import users from "../routes/users";
import { createMockEnv } from "./setup";
import type { Env, Variables } from "../types";
import { JWTService } from "../auth/jwt";

const STUB_USER = {
  id: 42, username: "alice", email: "alice@example.com",
  password_hash: "hash", preferences: "{}",
  gitlab_user_id: null, gitlab_token: null, gitlab_username: null,
  created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z",
};

function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use("*", async (c, next) => { c.env = env; await next(); });
  app.route("/api/v2/users", users);
  return app;
}

async function authedRequest(app: any, env: Env, path: string) {
  const jwt = new JWTService(env);
  const token = await jwt.createAccessToken(STUB_USER.username);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
}

describe("GET /api/v2/users/lookup", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns 200 + user when username exists", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn()
          .mockResolvedValueOnce(STUB_USER) // authMiddleware lookup
          .mockResolvedValueOnce({ id: 7, username: "anna" }), // route lookup
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "/api/v2/users/lookup?username=anna");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 7, username: "anna" });
  });

  it("returns 404 when username is missing", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn()
          .mockResolvedValueOnce(STUB_USER)
          .mockResolvedValueOnce(null),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "/api/v2/users/lookup?username=ghost");
    expect(res.status).toBe(404);
  });

  it("returns 400 when username param is missing", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValueOnce(STUB_USER),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "/api/v2/users/lookup");
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = buildApp(env);
    const res = await app.fetch(
      new Request("http://localhost/api/v2/users/lookup?username=anna"),
      env
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4.2: Run, expect failure.**

```bash
npx vitest run src/tests/users.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement the route.**

Create `src/routes/users.ts`:

```ts
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { authMiddleware } from "../middleware/auth";
import { lookupUserByUsername } from "../services/user-lookup";

const users = new Hono<{ Bindings: Env; Variables: Variables }>();

users.use("*", authMiddleware);

/**
 * GET /api/v2/users/lookup?username=X
 *
 * Resolve a username to a public user record. Auth-gated so anonymous
 * scrapers can't enumerate users; case-sensitive to match existing auth
 * behaviour. Used by the "Add member" UX in SharePanel and OrgSettings.
 */
users.get("/lookup", async (c) => {
  const username = c.req.query("username");
  if (!username || username.trim() === "") {
    return c.json({ error: "username query parameter is required" }, 400);
  }
  const user = await lookupUserByUsername(c.env, username);
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }
  return c.json(user);
});

export default users;
```

- [ ] **Step 4.4: Register the route in `src/index.ts`.**

Find the section that registers routes (should look like `app.route("/api/v2/projects", projects)` etc.). Add:

```ts
import users from "./routes/users";
// ...
app.route("/api/v2/users", users);
```

- [ ] **Step 4.5: Run, expect pass.**

```bash
npx vitest run src/tests/users.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 4.6: Commit.**

```bash
git add src/routes/users.ts src/index.ts src/tests/users.test.ts
git commit -m "feat(server): GET /users/lookup endpoint

Auth-gated username resolver — frontend uses this before adding a user
to a project or org. 404 on miss, 400 on missing param."
```

---

### Task 5: Org-permissions service helpers

**Files:**
- Create: `src/services/org-permissions.ts`

- [ ] **Step 5.1: Write the failing tests.**

Create `src/tests/org-permissions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getOrCreateUserOrg,
  getOrgMemberRole,
  listOrgMembersWithUsers,
  listUserDirectMembershipsInOrg,
} from "../services/org-permissions";
import type { Env } from "../types";
import { createMockEnv } from "./setup";

describe("getOrCreateUserOrg", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns existing org when one is owned by the user", async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 5, name: "Wendy's workspace" }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const result = await getOrCreateUserOrg(env, { id: 1, username: "wendy" } as any);
    expect(result).toEqual({ id: 5, name: "Wendy's workspace", role: 700 });
  });

  it("creates org + owner row when user has none", async () => {
    const queue = [
      null, // SELECT existing org → none
      { id: 99 }, // INSERT org RETURNING id
      { success: true }, // INSERT org_members
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const result = await getOrCreateUserOrg(env, { id: 1, username: "wendy" } as any);
    expect(result.id).toBe(99);
    expect(result.role).toBe(700);
    expect(result.name).toBe("wendy's workspace");
  });
});

describe("getOrgMemberRole", () => {
  it("returns role_level when row exists", async () => {
    const env = createMockEnv();
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ role_level: 600 }),
      }),
    }));
    const result = await getOrgMemberRole(env, 5, 7);
    expect(result).toBe(600);
  });

  it("returns null when no row", async () => {
    const env = createMockEnv();
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
      }),
    }));
    expect(await getOrgMemberRole(env, 5, 99)).toBeNull();
  });
});

describe("listOrgMembersWithUsers", () => {
  it("joins users and returns rows", async () => {
    const env = createMockEnv();
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            { user_id: 1, username: "wendy", role_level: 700 },
            { user_id: 2, username: "anna", role_level: 600 },
          ],
        }),
      }),
    }));
    const rows = await listOrgMembersWithUsers(env, 5);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ userId: 1, username: "wendy", roleLevel: 700 });
  });
});

describe("listUserDirectMembershipsInOrg", () => {
  it("returns project_members rows scoped to a single org", async () => {
    const env = createMockEnv();
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            { project_id: "p1", project_name: "P1", role_level: 400 },
            { project_id: "p3", project_name: "P3", role_level: 200 },
          ],
        }),
      }),
    }));
    const rows = await listUserDirectMembershipsInOrg(env, 5, 7);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ projectId: "p1", projectName: "P1", roleLevel: 400 });
  });
});
```

- [ ] **Step 5.2: Run, expect failure.**

```bash
npx vitest run src/tests/org-permissions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement.**

Create `src/services/org-permissions.ts`:

```ts
import type { Env, User } from "../types";

export interface UserOrg {
  id: number;
  name: string | null;
  role: number; // 700 — caller is always owner of their personal org
}

/**
 * Return the user's owned organization, lazy-creating one if absent.
 * Personal orgs are created without a Stripe customer (migration 0017
 * relaxed the NOT NULL constraint). The caller becomes role 700 owner.
 */
export async function getOrCreateUserOrg(env: Env, user: User): Promise<UserOrg> {
  const existing = (await env.DB.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1"
  )
    .bind(user.id)
    .first()) as { id: number; name: string | null } | null;

  if (existing) {
    return { id: existing.id, name: existing.name, role: 700 };
  }

  const name = `${user.username}'s workspace`;
  const inserted = (await env.DB.prepare(
    `INSERT INTO organizations (name, owner_user_id, subscription_tier)
     VALUES (?, ?, 'free') RETURNING id`
  )
    .bind(name, user.id)
    .first()) as { id: number };

  await env.DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (?, ?, 700, ?)
     ON CONFLICT(org_id, user_id) DO NOTHING`
  )
    .bind(inserted.id, user.id, user.id)
    .run();

  return { id: inserted.id, name, role: 700 };
}

/** Return the role_level of (org_id, user_id) or null if no row. */
export async function getOrgMemberRole(
  env: Env,
  orgId: number,
  userId: number
): Promise<number | null> {
  const row = (await env.DB.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?"
  )
    .bind(orgId, userId)
    .first()) as { role_level: number } | null;
  return row?.role_level ?? null;
}

export interface OrgMemberWithUser {
  userId: number;
  username: string;
  roleLevel: number;
}

/** All org members joined to users for display. */
export async function listOrgMembersWithUsers(
  env: Env,
  orgId: number
): Promise<OrgMemberWithUser[]> {
  const result = (await env.DB.prepare(
    `SELECT om.user_id AS user_id, u.username AS username, om.role_level AS role_level
     FROM org_members om
     INNER JOIN users u ON u.id = om.user_id
     WHERE om.org_id = ?
     ORDER BY om.role_level DESC, u.username ASC`
  )
    .bind(orgId)
    .all()) as { results: Array<{ user_id: number; username: string; role_level: number }> };

  return (result.results ?? []).map((r) => ({
    userId: r.user_id,
    username: r.username,
    roleLevel: r.role_level,
  }));
}

export interface ProjectMembershipInOrg {
  projectId: string;
  projectName: string;
  roleLevel: number;
}

/**
 * For "remove from org" confirmation: list projects in this org where the
 * given user has a direct project_members row.
 */
export async function listUserDirectMembershipsInOrg(
  env: Env,
  orgId: number,
  userId: number
): Promise<ProjectMembershipInOrg[]> {
  const result = (await env.DB.prepare(
    `SELECT pm.project_id AS project_id, p.name AS project_name, pm.role_level AS role_level
     FROM project_members pm
     INNER JOIN projects p ON p.id = pm.project_id
     WHERE p.org_id = ? AND pm.user_id = ?
     ORDER BY p.name ASC`
  )
    .bind(orgId, userId)
    .all()) as { results: Array<{ project_id: string; project_name: string; role_level: number }> };

  return (result.results ?? []).map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name,
    roleLevel: r.role_level,
  }));
}
```

- [ ] **Step 5.4: Run, expect pass.**

```bash
npx vitest run src/tests/org-permissions.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5.5: Commit.**

```bash
git add src/services/org-permissions.ts src/tests/org-permissions.test.ts
git commit -m "feat(server): org-permissions service (lazy-create + member queries)"
```

---

### Task 6: Add tier-3 (org) to `resolveProjectRole`

**Files:**
- Modify: `src/services/project-permissions.ts`

- [ ] **Step 6.1: Write the failing test.**

Create `src/tests/project-permissions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveProjectRole } from "../services/project-permissions";
import type { Env, User } from "../types";
import { createMockEnv } from "./setup";

const STUB_USER: User = {
  id: 7, username: "anna", email: "a@b.c", password_hash: "h", preferences: "{}",
  gitlab_user_id: null, gitlab_token: null, gitlab_username: null,
  created_at: "", updated_at: "",
} as User;

function stageQueries(env: Env, results: unknown[]) {
  const q = [...results];
  (env.DB.prepare as any).mockImplementation(() => ({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockImplementation(() => Promise.resolve(q.shift() ?? null)),
    }),
  }));
}

describe("resolveProjectRole — tier 3 org_members", () => {
  it("falls through to org tier when no override and not creator", async () => {
    const env = createMockEnv();
    stageQueries(env, [
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: 5 }, // project
      null, // project_members override miss
      { role_level: 600 }, // org_members hit
    ]);
    const role = await resolveProjectRole(env, STUB_USER, "p1");
    expect(role).toEqual({ level: 600, name: "maintainer", source: "org" });
  });

  it("override (tier 1) wins over org membership", async () => {
    const env = createMockEnv();
    stageQueries(env, [
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: 5 },
      { role_level: 200 }, // override hit — should win
    ]);
    const role = await resolveProjectRole(env, STUB_USER, "p1");
    expect(role).toEqual({ level: 200, name: "commenter", source: "override" });
  });

  it("creator (tier 2) wins over org membership", async () => {
    const env = createMockEnv();
    stageQueries(env, [
      { id: "p1", gitlab_project_id: null, created_by: 7, org_id: 5 }, // user IS creator
      null, // override miss
    ]);
    const role = await resolveProjectRole(env, STUB_USER, "p1");
    expect(role).toEqual({ level: 700, name: "owner", source: "creator" });
  });

  it("returns null when project.org_id is null and no other tier hits", async () => {
    const env = createMockEnv();
    stageQueries(env, [
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      null, // override miss
    ]);
    const role = await resolveProjectRole(env, STUB_USER, "p1");
    expect(role).toBeNull();
  });

  it("skips org tier when org_id is null but still tries gitlab tier", async () => {
    const env = createMockEnv();
    const userWithGitlab = { ...STUB_USER, gitlab_user_id: 1, gitlab_token: "x" } as User;
    stageQueries(env, [
      { id: "p1", gitlab_project_id: 42, created_by: 99, org_id: null },
      null, // override miss
    ]);
    // GitLab tier will be hit — getGitLabProjectAccessLevel does network; we
    // accept null fallback in this test (no fetch mock = returns null silently).
    const role = await resolveProjectRole(env, userWithGitlab, "p1");
    expect(role).toBeNull();
  });
});
```

- [ ] **Step 6.2: Run, expect failure.**

```bash
npx vitest run src/tests/project-permissions.test.ts
```

Expected: FAIL — current `resolveProjectRole` doesn't include `org_id` in its SELECT and doesn't have an org tier; first test fails because `org` source isn't returned.

- [ ] **Step 6.3: Update `src/services/project-permissions.ts`.**

In `resolveProjectRoleInternal`, change the project SELECT to include `org_id`, and insert tier 3 between the creator check and the GitLab fallback:

```ts
// Find:
const project = (await env.DB.prepare(
  `SELECT id, gitlab_project_id, created_by FROM projects WHERE id = ?${archivedFilter}`
)
  .bind(projectId)
  .first()) as
  | { id: string; gitlab_project_id: number | null; created_by: number }
  | null;

// Replace with:
const project = (await env.DB.prepare(
  `SELECT id, gitlab_project_id, created_by, org_id FROM projects WHERE id = ?${archivedFilter}`
)
  .bind(projectId)
  .first()) as
  | { id: string; gitlab_project_id: number | null; created_by: number; org_id: number | null }
  | null;
```

Update the `ResolvedRole` source type:

```ts
export interface ResolvedRole {
  level: number;
  name: string;
  source: "override" | "gitlab" | "creator" | "org";
}
```

Insert the tier-3 lookup between the creator block and the GitLab block:

```ts
// Tier 3: org membership grants role on every project in that org.
if (project.org_id != null) {
  const orgRow = (await env.DB.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?"
  )
    .bind(project.org_id, user.id)
    .first()) as { role_level: number } | null;
  if (orgRow) {
    return {
      level: orgRow.role_level,
      name: ROLE_NAMES[orgRow.role_level] ?? "unknown",
      source: "org",
    };
  }
}
```

Also update the file-level docstring on `resolveProjectRole` to mention four tiers.

- [ ] **Step 6.4: Run, expect pass.**

```bash
npx vitest run src/tests/project-permissions.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6.5: Re-run the full server suite to catch regressions.**

```bash
npm test -- --run
```

Expected: all tests pass. Existing `sync-token.test.ts` and `project-invites.test.ts` rely on `resolveProjectRole`; the new `org_id` column in the SELECT shouldn't break them (the helper uses fewer fields than it returns), but verify.

- [ ] **Step 6.6: Commit.**

```bash
git add src/services/project-permissions.ts src/tests/project-permissions.test.ts
git commit -m "feat(server): org_members tier in resolveProjectRole

Inserts a new tier 3 between creator (tier 2) and GitLab (tier 4):
when projects.org_id is set and the user has a row in org_members for
that org, the row's role_level becomes their effective project role."
```

---

### Task 7: Update `GET /api/v2/projects` to include org-resolved access

**Files:**
- Modify: `src/routes/projects.ts`
- Modify (or create): `src/tests/projects.test.ts`

- [ ] **Step 7.1: Locate the existing `GET /` handler.**

Run: `grep -n "projects.get(\"/\"" src/routes/projects.ts` — this finds the listing handler. Read the current SQL it issues. It selects projects where `created_by = ?` ∪ `EXISTS(... project_members ...)`.

- [ ] **Step 7.2: Write the failing test.**

Add to `src/tests/projects.test.ts` (create if missing — same setup as `project-invites.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import projects from "../routes/projects";
import { createMockEnv } from "./setup";
import type { Env, Variables } from "../types";
import { JWTService } from "../auth/jwt";

const STUB_USER = {
  id: 7, username: "anna", email: "a@b.c", password_hash: "h", preferences: "{}",
  gitlab_user_id: null, gitlab_token: null, gitlab_username: null,
  created_at: "", updated_at: "",
};

function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use("*", async (c, next) => { c.env = env; await next(); });
  app.route("/api/v2/projects", projects);
  return app;
}

async function authedGet(app: any, env: Env, path: string) {
  const jwt = new JWTService(env);
  const token = await jwt.createAccessToken(STUB_USER.username);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
}

describe("GET /api/v2/projects — org access", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("includes projects whose org appears in the user's org_members", async () => {
    const queue = [
      STUB_USER,
      // listing query returns three projects: one creator, one project_members,
      // one org-only.
      // The route runs a single SELECT with UNION; mock it as `all()`.
    ];
    (env.DB.prepare as any).mockImplementation((sql: string) => {
      const isAll = /UNION|org_members/.test(sql);
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
          all: vi.fn().mockResolvedValue({
            results: isAll ? [
              { id: "p1", name: "Direct creator", org_id: null, gitlab_project_id: null, created_at: "", updated_at: "", archived_at: null },
              { id: "p2", name: "Project member", org_id: null, gitlab_project_id: null, created_at: "", updated_at: "", archived_at: null },
              { id: "p3", name: "Org member", org_id: 5, gitlab_project_id: null, created_at: "", updated_at: "", archived_at: null },
            ] : [],
          }),
        }),
      };
    });

    const app = buildApp(env);
    const res = await authedGet(app, env, "/api/v2/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    const ids = body.projects.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
  });
});
```

- [ ] **Step 7.3: Run, expect failure.**

```bash
npx vitest run src/tests/projects.test.ts
```

Expected: FAIL (the org-only project isn't in the listing).

- [ ] **Step 7.4: Update the listing SQL.**

In `src/routes/projects.ts`, find the listing handler and change the projects SELECT to add a third UNION branch covering org membership. The query should be roughly:

```sql
SELECT id, name, gitlab_project_id, org_id, created_at, updated_at, archived_at
FROM projects
WHERE archived_at IS NULL
  AND (
    created_by = ?
    OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ?)
    OR (org_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM org_members om WHERE om.org_id = projects.org_id AND om.user_id = ?
    ))
  )
ORDER BY updated_at DESC
```

Bind `user.id` three times. Confirm the response shape (which existing clients consume) is unchanged — only the row set widens.

- [ ] **Step 7.5: Run, expect pass.**

```bash
npx vitest run src/tests/projects.test.ts
```

Expected: PASS, including any pre-existing tests in the file.

- [ ] **Step 7.6: Run full suite.**

```bash
npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 7.7: Commit.**

```bash
git add src/routes/projects.ts src/tests/projects.test.ts
git commit -m "feat(server): GET /projects surfaces org-resolved access

Listing now includes projects where the caller has an org_members row
for projects.org_id, in addition to creator/project_members rows. Lets
org maintainers see every project in the org without explicit member
adds."
```

---

### Task 8: Set `org_id` on project create

**Files:**
- Modify: `src/routes/projects.ts` (the project-create handler — likely a POST handler that inserts into `projects`)

- [ ] **Step 8.1: Locate the project create handler.**

Run: `grep -n "INSERT INTO projects" src/routes/projects.ts`

- [ ] **Step 8.2: Write the failing test.**

Add to `src/tests/projects.test.ts`:

```ts
describe("project creation auto-sets org_id", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("inserts org_id from the caller's lazy-created org", async () => {
    const captured: { sql: string; args: unknown[] }[] = [];
    const queue = [
      STUB_USER, // authMiddleware
      { id: 5, name: "anna's workspace" }, // existing org
      // any further reads return null
    ];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockImplementation(() => {
          captured.push({ sql, args });
          return Promise.resolve({ success: true });
        }),
      })),
    }));

    const app = buildApp(env);
    const jwt = new JWTService(env);
    const token = await jwt.createAccessToken(STUB_USER.username);
    const res = await app.fetch(
      new Request("http://localhost/api/v2/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: "p-new", name: "P-new" }),
      }),
      env
    );
    expect(res.status).toBeLessThan(500);
    const insert = captured.find((c) => /INSERT INTO projects/i.test(c.sql));
    expect(insert).toBeDefined();
    // org_id should be one of the args in the INSERT
    expect(insert!.args).toContain(5);
  });
});
```

- [ ] **Step 8.3: Run, expect failure.**

```bash
npx vitest run src/tests/projects.test.ts
```

Expected: the new test fails — current INSERT doesn't include `org_id`.

- [ ] **Step 8.4: Update the create handler.**

In the project-create handler:

1. Import `getOrCreateUserOrg` from `../services/org-permissions`.
2. Before the `INSERT INTO projects` statement, call `const userOrg = await getOrCreateUserOrg(c.env, user);`.
3. Add `org_id` to the INSERT column list and `userOrg.id` to the bound args.

Example (adapt to existing handler structure):

```ts
const userOrg = await getOrCreateUserOrg(c.env, user);
await c.env.DB.prepare(
  `INSERT INTO projects (id, name, gitlab_project_id, org_id, created_by)
   VALUES (?, ?, ?, ?, ?)`
)
  .bind(body.id, body.name, body.gitlab_project_id ?? null, userOrg.id, user.id)
  .run();
```

If the handler uses `INSERT OR IGNORE` or upsert semantics, preserve them — only add the column.

- [ ] **Step 8.5: Run, expect pass.**

```bash
npx vitest run src/tests/projects.test.ts
npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 8.6: Commit.**

```bash
git add src/routes/projects.ts src/tests/projects.test.ts
git commit -m "feat(server): auto-bind new projects to caller's org

Project create now lazy-creates the caller's personal org (free, no
Stripe customer required) and stores its id on projects.org_id."
```

---

## Phase 2 — Org and project member endpoints

### Task 9: `GET /api/v2/orgs/me`

**Files:**
- Create: `src/routes/orgs.ts`
- Modify: `src/index.ts`

- [ ] **Step 9.1: Write the failing test.**

Create `src/tests/orgs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import orgs from "../routes/orgs";
import { createMockEnv } from "./setup";
import type { Env, Variables } from "../types";
import { JWTService } from "../auth/jwt";

const STUB_USER = {
  id: 7, username: "anna", email: "a@b.c", password_hash: "h", preferences: "{}",
  gitlab_user_id: null, gitlab_token: null, gitlab_username: null,
  created_at: "", updated_at: "",
};

function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use("*", async (c, next) => { c.env = env; await next(); });
  app.route("/api/v2/orgs", orgs);
  return app;
}

async function authedRequest(app: any, env: Env, method: string, path: string, body?: unknown) {
  const jwt = new JWTService(env);
  const token = await jwt.createAccessToken(STUB_USER.username);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env
  );
}

describe("GET /api/v2/orgs/me", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns existing org", async () => {
    const queue = [STUB_USER, { id: 5, name: "anna's workspace" }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 5, name: "anna's workspace", role: { level: 700, name: "owner" } });
  });

  it("lazy-creates an org when none exists", async () => {
    const queue = [STUB_USER, null, { id: 99 }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(99);
    expect(body.role.level).toBe(700);
  });
});
```

- [ ] **Step 9.2: Run, expect failure.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 9.3: Implement.**

Create `src/routes/orgs.ts`:

```ts
import { Hono } from "hono";
import type { Env, User, Variables } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getOrCreateUserOrg, getOrgMemberRole } from "../services/org-permissions";
import { ROLE_NAMES } from "../services/project-permissions";

const orgs = new Hono<{ Bindings: Env; Variables: Variables }>();

orgs.use("*", authMiddleware);

/**
 * GET /api/v2/orgs/me
 *
 * Return the caller's owned organization (lazy-create on first hit). The
 * caller is always returned at role 700 — they own the org.
 */
orgs.get("/me", async (c) => {
  const user = c.get("user") as User;
  const org = await getOrCreateUserOrg(c.env, user);
  return c.json({
    id: org.id,
    name: org.name,
    role: { level: org.role, name: ROLE_NAMES[org.role] ?? "owner" },
  });
});

export default orgs;
```

Register in `src/index.ts`:

```ts
import orgs from "./routes/orgs";
// ...
app.route("/api/v2/orgs", orgs);
```

- [ ] **Step 9.4: Run, expect pass.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 9.5: Commit.**

```bash
git add src/routes/orgs.ts src/index.ts src/tests/orgs.test.ts
git commit -m "feat(server): GET /orgs/me with lazy org creation"
```

---

### Task 10: `GET /api/v2/orgs/:id/members`

**Files:**
- Modify: `src/routes/orgs.ts`
- Modify: `src/tests/orgs.test.ts`

- [ ] **Step 10.1: Write the failing test.**

Add to `src/tests/orgs.test.ts`:

```ts
describe("GET /api/v2/orgs/:id/members", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns 200 with members when caller is a member", async () => {
    const queue = [
      STUB_USER, // auth
      { role_level: 700 }, // gate: org member check
    ];
    const allResult = {
      results: [
        { user_id: 1, username: "wendy", role_level: 700 },
        { user_id: 7, username: "anna", role_level: 600 },
      ],
    };
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        all: vi.fn().mockResolvedValue(allResult),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/5/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ username: string }> };
    expect(body.members.map((m) => m.username)).toEqual(["wendy", "anna"]);
  });

  it("returns 403 when caller is not an org member", async () => {
    const queue = [STUB_USER, null]; // auth, then no role
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/5/members");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 10.2: Run, expect failure.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: FAIL — endpoint not found.

- [ ] **Step 10.3: Implement.**

Add to `src/routes/orgs.ts`:

```ts
import { listOrgMembersWithUsers } from "../services/org-permissions";

orgs.get("/:orgId/members", async (c) => {
  const user = c.get("user") as User;
  const orgId = parseInt(c.req.param("orgId"), 10);
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400);

  const role = await getOrgMemberRole(c.env, orgId, user.id);
  if (role == null) return c.json({ error: "not an org member" }, 403);

  const members = await listOrgMembersWithUsers(c.env, orgId);
  return c.json({
    members: members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: { level: m.roleLevel, name: ROLE_NAMES[m.roleLevel] ?? "unknown" },
    })),
  });
});
```

- [ ] **Step 10.4: Run, expect pass.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: PASS, 4 tests total in file.

- [ ] **Step 10.5: Commit.**

```bash
git add src/routes/orgs.ts src/tests/orgs.test.ts
git commit -m "feat(server): GET /orgs/:id/members listing endpoint"
```

---

### Task 11: `POST /api/v2/orgs/:id/members`

**Files:**
- Modify: `src/routes/orgs.ts`, `src/tests/orgs.test.ts`

- [ ] **Step 11.1: Write the failing test.**

Add to `src/tests/orgs.test.ts`:

```ts
describe("POST /api/v2/orgs/:id/members", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns 403 when caller is not org owner (level 700)", async () => {
    const queue = [STUB_USER, { role_level: 600 }]; // auth, gate (caller is not 700)
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/orgs/5/members", {
      username: "anna", role: 600,
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when target username does not exist", async () => {
    const queue = [
      STUB_USER, // auth
      { role_level: 700 }, // gate
      null, // user lookup miss
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/orgs/5/members", {
      username: "ghost", role: 600,
    });
    expect(res.status).toBe(404);
  });

  it("inserts org_members row when caller is owner and target exists", async () => {
    const queue = [
      STUB_USER, // auth
      { role_level: 700 }, // gate
      { id: 11, username: "anna" }, // user lookup
    ];
    const captured: { sql: string; args: unknown[] }[] = [];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockImplementation(() => {
          captured.push({ sql, args });
          return Promise.resolve({ success: true });
        }),
      })),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/orgs/5/members", {
      username: "anna", role: 600,
    });
    expect(res.status).toBe(200);
    expect(captured.find((c) => /INSERT INTO org_members/i.test(c.sql))).toBeDefined();
  });

  it("rejects role > 700 with 400", async () => {
    const queue = [STUB_USER, { role_level: 700 }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/orgs/5/members", {
      username: "anna", role: 999,
    });
    expect(res.status).toBe(400);
  });

  it("rejects self-grant with 400", async () => {
    const queue = [
      STUB_USER, // auth
      { role_level: 700 }, // gate
      { id: 7, username: "anna" }, // user lookup — same id as STUB_USER
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/orgs/5/members", {
      username: "anna", role: 600,
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 11.2: Run, expect failure.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: FAIL.

- [ ] **Step 11.3: Implement.**

Add to `src/routes/orgs.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { lookupUserByUsername } from "../services/user-lookup";

const orgMemberBody = z.object({
  username: z.string().min(1),
  role: z.number().int().min(100).max(700),
});

orgs.post(
  "/:orgId/members",
  zValidator("json", orgMemberBody),
  async (c) => {
    const user = c.get("user") as User;
    const orgId = parseInt(c.req.param("orgId"), 10);
    if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400);

    const callerRole = await getOrgMemberRole(c.env, orgId, user.id);
    if (callerRole == null || callerRole < 700) {
      return c.json({ error: "only org owners can add members" }, 403);
    }

    const { username, role } = c.req.valid("json");
    const target = await lookupUserByUsername(c.env, username);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (target.id === user.id) {
      return c.json({ error: "cannot grant role to self" }, 400);
    }

    await c.env.DB.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = CURRENT_TIMESTAMP`
    )
      .bind(orgId, target.id, role, user.id)
      .run();

    return c.json({
      userId: target.id,
      username: target.username,
      role: { level: role, name: ROLE_NAMES[role] ?? "unknown" },
    });
  }
);
```

- [ ] **Step 11.4: Run, expect pass.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: PASS.

- [ ] **Step 11.5: Commit.**

```bash
git add src/routes/orgs.ts src/tests/orgs.test.ts
git commit -m "feat(server): POST /orgs/:id/members (owner-gated upsert)"
```

---

### Task 12: `DELETE /api/v2/orgs/:id/members/:userId`

**Files:**
- Modify: `src/routes/orgs.ts`, `src/tests/orgs.test.ts`

- [ ] **Step 12.1: Write the failing test.**

Add:

```ts
describe("DELETE /api/v2/orgs/:id/members/:userId", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns 200 when owner removes a member", async () => {
    const queue = [
      STUB_USER, // auth
      { role_level: 700 }, // gate
    ];
    const captured: { sql: string; args: unknown[] }[] = [];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockImplementation(() => {
          captured.push({ sql, args });
          return Promise.resolve({ success: true });
        }),
      })),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", "/api/v2/orgs/5/members/11");
    expect(res.status).toBe(200);
    expect(captured.find((c) => /DELETE FROM org_members/i.test(c.sql))).toBeDefined();
  });

  it("rejects self-removal (owner can't remove self)", async () => {
    const queue = [STUB_USER, { role_level: 700 }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", `/api/v2/orgs/5/members/${STUB_USER.id}`);
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not owner", async () => {
    const queue = [STUB_USER, { role_level: 600 }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", "/api/v2/orgs/5/members/11");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 12.2: Run, expect failure.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: FAIL.

- [ ] **Step 12.3: Implement.**

Add to `src/routes/orgs.ts`:

```ts
orgs.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user") as User;
  const orgId = parseInt(c.req.param("orgId"), 10);
  const targetUserId = parseInt(c.req.param("userId"), 10);
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400);
  }

  const callerRole = await getOrgMemberRole(c.env, orgId, user.id);
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can remove members" }, 403);
  }
  if (targetUserId === user.id) {
    return c.json({ error: "owner cannot remove self" }, 400);
  }

  await c.env.DB.prepare(
    "DELETE FROM org_members WHERE org_id = ? AND user_id = ?"
  )
    .bind(orgId, targetUserId)
    .run();

  return c.json({ removed: true });
});
```

- [ ] **Step 12.4: Run, expect pass.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: PASS.

- [ ] **Step 12.5: Commit.**

```bash
git add src/routes/orgs.ts src/tests/orgs.test.ts
git commit -m "feat(server): DELETE /orgs/:id/members/:userId"
```

---

### Task 13: `GET /api/v2/orgs/:id/members/:userId/projects`

**Files:**
- Modify: `src/routes/orgs.ts`, `src/tests/orgs.test.ts`

- [ ] **Step 13.1: Write the failing test.**

```ts
describe("GET /api/v2/orgs/:id/members/:userId/projects", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns the user's direct project memberships scoped to the org", async () => {
    const queue = [STUB_USER, { role_level: 700 }];
    const allResult = {
      results: [
        { project_id: "p1", project_name: "P1", role_level: 400 },
        { project_id: "p3", project_name: "P3", role_level: 200 },
      ],
    };
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        all: vi.fn().mockResolvedValue(allResult),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/5/members/11/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("returns 403 when caller is not owner", async () => {
    const queue = [STUB_USER, { role_level: 600 }];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/orgs/5/members/11/projects");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 13.2: Run, expect failure.**

```bash
npx vitest run src/tests/orgs.test.ts
```

- [ ] **Step 13.3: Implement.**

Add to `src/routes/orgs.ts`:

```ts
import { listUserDirectMembershipsInOrg } from "../services/org-permissions";

orgs.get("/:orgId/members/:userId/projects", async (c) => {
  const user = c.get("user") as User;
  const orgId = parseInt(c.req.param("orgId"), 10);
  const targetUserId = parseInt(c.req.param("userId"), 10);
  if (!Number.isFinite(orgId) || !Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid id" }, 400);
  }
  const callerRole = await getOrgMemberRole(c.env, orgId, user.id);
  if (callerRole == null || callerRole < 700) {
    return c.json({ error: "only org owners can list memberships" }, 403);
  }

  const rows = await listUserDirectMembershipsInOrg(c.env, orgId, targetUserId);
  return c.json({
    projects: rows.map((r) => ({
      id: r.projectId,
      name: r.projectName,
      role: { level: r.roleLevel, name: ROLE_NAMES[r.roleLevel] ?? "unknown" },
    })),
  });
});
```

- [ ] **Step 13.4: Run, expect pass.**

```bash
npx vitest run src/tests/orgs.test.ts
```

Expected: PASS.

- [ ] **Step 13.5: Commit.**

```bash
git add src/routes/orgs.ts src/tests/orgs.test.ts
git commit -m "feat(server): GET /orgs/:id/members/:userId/projects

Powers the remove-from-org confirmation flow — surfaces direct
project_members rows so the actor can opt-in to also removing them."
```

---

### Task 14: `GET /api/v2/projects/:id/members`

**Files:**
- Modify: `src/routes/projects.ts`
- Create: `src/tests/project-members.test.ts`

- [ ] **Step 14.1: Write the failing test.**

Create `src/tests/project-members.test.ts` (use the same auth helper pattern as project-invites.test.ts):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import projects from "../routes/projects";
import { createMockEnv } from "./setup";
import type { Env, Variables } from "../types";
import { JWTService } from "../auth/jwt";

const STUB_USER = {
  id: 7, username: "anna", email: "a@b.c", password_hash: "h", preferences: "{}",
  gitlab_user_id: null, gitlab_token: null, gitlab_username: null,
  created_at: "", updated_at: "",
};

function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use("*", async (c, next) => { c.env = env; await next(); });
  app.route("/api/v2/projects", projects);
  return app;
}

async function authedRequest(app: any, env: Env, method: string, path: string, body?: unknown) {
  const jwt = new JWTService(env);
  const token = await jwt.createAccessToken(STUB_USER.username);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env
  );
}

describe("GET /api/v2/projects/:id/members", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("returns 200 with effective members (project + org + creator)", async () => {
    const firstQueue = [
      STUB_USER, // auth
      { id: "p1", gitlab_project_id: null, created_by: 1, org_id: 5 }, // project (resolveRole)
      null, // override miss
      { role_level: 600 }, // org tier hit — caller is org member
      // members listing 'all' calls below
    ];
    const allResults = [
      // project_members union org_members result
      { user_id: 1, username: "wendy", role_level: 700, source: "creator" },
      { user_id: 7, username: "anna", role_level: 600, source: "org" },
      { user_id: 11, username: "clayton", role_level: 400, source: "override" },
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(firstQueue.shift() ?? null)),
        all: vi.fn().mockResolvedValue({ results: allResults }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/projects/p1/members");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ username: string }> };
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "clayton", "wendy"]);
  });

  it("returns 403 when caller has no access", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      null, // override miss
      // org tier skipped (org_id null), gitlab tier null user → null role
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "GET", "/api/v2/projects/p1/members");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 14.2: Run, expect failure.**

```bash
npx vitest run src/tests/project-members.test.ts
```

Expected: FAIL.

- [ ] **Step 14.3: Add a service helper for listing effective members.**

Add to `src/services/org-permissions.ts`:

```ts
export interface EffectiveMember {
  userId: number;
  username: string;
  roleLevel: number;
  source: "override" | "creator" | "org";
}

/**
 * Effective members for a project = direct project_members ∪ org_members of
 * the project's org, plus the creator if not already represented. Direct
 * project_members rows shadow org_members rows for the same user.
 */
export async function listEffectiveProjectMembers(
  env: Env,
  projectId: string,
  orgId: number | null,
  createdBy: number
): Promise<EffectiveMember[]> {
  const direct = (await env.DB.prepare(
    `SELECT pm.user_id AS user_id, u.username AS username, pm.role_level AS role_level
     FROM project_members pm
     INNER JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?`
  )
    .bind(projectId)
    .all()) as { results: Array<{ user_id: number; username: string; role_level: number }> };

  const directMap = new Map<number, EffectiveMember>();
  for (const r of direct.results ?? []) {
    directMap.set(r.user_id, {
      userId: r.user_id, username: r.username, roleLevel: r.role_level, source: "override",
    });
  }

  if (orgId != null) {
    const orgMembers = (await env.DB.prepare(
      `SELECT om.user_id AS user_id, u.username AS username, om.role_level AS role_level
       FROM org_members om
       INNER JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ?`
    )
      .bind(orgId)
      .all()) as { results: Array<{ user_id: number; username: string; role_level: number }> };

    for (const r of orgMembers.results ?? []) {
      if (!directMap.has(r.user_id)) {
        directMap.set(r.user_id, {
          userId: r.user_id, username: r.username, roleLevel: r.role_level, source: "org",
        });
      }
    }
  }

  if (!directMap.has(createdBy)) {
    const creator = (await env.DB.prepare(
      "SELECT id, username FROM users WHERE id = ?"
    )
      .bind(createdBy)
      .first()) as { id: number; username: string } | null;
    if (creator) {
      directMap.set(creator.id, {
        userId: creator.id, username: creator.username, roleLevel: 700, source: "creator",
      });
    }
  }

  return Array.from(directMap.values()).sort((a, b) => b.roleLevel - a.roleLevel || a.username.localeCompare(b.username));
}
```

- [ ] **Step 14.4: Implement the endpoint.**

In `src/routes/projects.ts`, add:

```ts
import { listEffectiveProjectMembers } from "../services/org-permissions";

projects.get("/:projectId/members", async (c) => {
  const user = c.get("user") as User;
  const projectId = c.req.param("projectId");
  const role = await resolveProjectRole(c.env, user, projectId);
  if (!role) return c.json({ error: "no access to project" }, 403);

  const project = (await c.env.DB.prepare(
    "SELECT created_by, org_id FROM projects WHERE id = ?"
  )
    .bind(projectId)
    .first()) as { created_by: number; org_id: number | null } | null;
  if (!project) return c.json({ error: "project not found" }, 404);

  const members = await listEffectiveProjectMembers(
    c.env, projectId, project.org_id, project.created_by
  );

  return c.json({
    members: members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: { level: m.roleLevel, name: ROLE_NAMES[m.roleLevel] ?? "unknown", source: m.source },
    })),
  });
});
```

- [ ] **Step 14.5: Run, expect pass.**

```bash
npx vitest run src/tests/project-members.test.ts
```

Expected: PASS.

- [ ] **Step 14.6: Commit.**

```bash
git add src/services/org-permissions.ts src/routes/projects.ts src/tests/project-members.test.ts
git commit -m "feat(server): GET /projects/:id/members with effective union"
```

---

### Task 15: `POST /api/v2/projects/:id/members`

**Files:**
- Modify: `src/routes/projects.ts`, `src/tests/project-members.test.ts`

- [ ] **Step 15.1: Write the failing test.**

Add to `src/tests/project-members.test.ts`:

```ts
describe("POST /api/v2/projects/:id/members", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("requires role >= 500 (project_lead)", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 400 }, // override gives caller 400 — below 500
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/projects/p1/members", {
      username: "clayton", role: 400,
    });
    expect(res.status).toBe(403);
  });

  it("inserts project_members row when caller is project_lead+", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 600 }, // caller maintainer
      { id: 11, username: "clayton" }, // user lookup
    ];
    const captured: { sql: string; args: unknown[] }[] = [];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockImplementation(() => {
          captured.push({ sql, args });
          return Promise.resolve({ success: true });
        }),
      })),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/projects/p1/members", {
      username: "clayton", role: 400,
    });
    expect(res.status).toBe(200);
    expect(captured.find((c) => /INSERT INTO project_members/i.test(c.sql))).toBeDefined();
  });

  it("rejects role > caller's role", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 500 }, // caller project_lead
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/projects/p1/members", {
      username: "clayton", role: 700,
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when target username does not exist", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 600 },
      null, // user lookup miss
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/projects/p1/members", {
      username: "ghost", role: 400,
    });
    expect(res.status).toBe(404);
  });

  it("rejects self-grant", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 600 },
      { id: 7, username: "anna" }, // same as STUB_USER
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "POST", "/api/v2/projects/p1/members", {
      username: "anna", role: 400,
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 15.2: Run, expect failure.**

```bash
npx vitest run src/tests/project-members.test.ts
```

- [ ] **Step 15.3: Implement.**

Add to `src/routes/projects.ts`:

```ts
import { lookupUserByUsername } from "../services/user-lookup";

const projectMemberBody = z.object({
  username: z.string().min(1),
  role: z.number().int().min(100).max(700),
});

projects.post(
  "/:projectId/members",
  zValidator("json", projectMemberBody),
  async (c) => {
    const user = c.get("user") as User;
    const projectId = c.req.param("projectId");
    const callerRole = await resolveProjectRole(c.env, user, projectId);
    if (!callerRole) return c.json({ error: "no access to project" }, 403);
    if (callerRole.level < 500) {
      return c.json({ error: "role >= project_lead required" }, 403);
    }

    const { username, role } = c.req.valid("json");
    if (role > callerRole.level) {
      return c.json(
        { error: `cannot grant role ${role} as ${callerRole.name} (${callerRole.level})` },
        403
      );
    }

    const target = await lookupUserByUsername(c.env, username);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (target.id === user.id) {
      return c.json({ error: "cannot grant role to self" }, 400);
    }

    await c.env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = CURRENT_TIMESTAMP`
    )
      .bind(projectId, target.id, role, user.id)
      .run();

    return c.json({
      userId: target.id,
      username: target.username,
      role: { level: role, name: ROLE_NAMES[role] ?? "unknown", source: "override" },
    });
  }
);
```

- [ ] **Step 15.4: Run, expect pass.**

```bash
npx vitest run src/tests/project-members.test.ts
```

Expected: PASS.

- [ ] **Step 15.5: Commit.**

```bash
git add src/routes/projects.ts src/tests/project-members.test.ts
git commit -m "feat(server): POST /projects/:id/members (direct add by username)"
```

---

### Task 16: `DELETE /api/v2/projects/:id/members/:userId`

**Files:**
- Modify: `src/routes/projects.ts`, `src/tests/project-members.test.ts`

- [ ] **Step 16.1: Write the failing test.**

```ts
describe("DELETE /api/v2/projects/:id/members/:userId", () => {
  let env: Env;
  beforeEach(() => (env = createMockEnv()));

  it("requires role >= 600 (maintainer)", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: null },
      { role_level: 500 }, // project_lead — below 600
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", "/api/v2/projects/p1/members/11");
    expect(res.status).toBe(403);
  });

  it("returns 409 when target has no project_members row (org-only access)", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: 5 },
      { role_level: 700 }, // caller maintainer/owner via creator/override
      null, // SELECT existing project_members row → none
    ];
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", "/api/v2/projects/p1/members/11");
    expect(res.status).toBe(409);
  });

  it("removes row and returns 200", async () => {
    const queue = [
      STUB_USER,
      { id: "p1", gitlab_project_id: null, created_by: 99, org_id: 5 },
      { role_level: 700 },
      { role_level: 400 }, // existing project_members row
    ];
    const captured: { sql: string; args: unknown[] }[] = [];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? null)),
        run: vi.fn().mockImplementation(() => {
          captured.push({ sql, args });
          return Promise.resolve({ success: true });
        }),
      })),
    }));
    const app = buildApp(env);
    const res = await authedRequest(app, env, "DELETE", "/api/v2/projects/p1/members/11");
    expect(res.status).toBe(200);
    expect(captured.find((c) => /DELETE FROM project_members/i.test(c.sql))).toBeDefined();
  });
});
```

- [ ] **Step 16.2: Run, expect failure.**

- [ ] **Step 16.3: Implement.**

Add to `src/routes/projects.ts`:

```ts
projects.delete("/:projectId/members/:userId", async (c) => {
  const user = c.get("user") as User;
  const projectId = c.req.param("projectId");
  const targetUserId = parseInt(c.req.param("userId"), 10);
  if (!Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid userId" }, 400);
  }

  const callerRole = await resolveProjectRole(c.env, user, projectId);
  if (!callerRole) return c.json({ error: "no access to project" }, 403);
  if (callerRole.level < 600) {
    return c.json({ error: "role >= maintainer required" }, 403);
  }

  const existing = (await c.env.DB.prepare(
    "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?"
  )
    .bind(projectId, targetUserId)
    .first()) as { role_level: number } | null;
  if (!existing) {
    return c.json(
      { error: "user has no direct project membership; remove from org instead" },
      409
    );
  }

  await c.env.DB.prepare(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?"
  )
    .bind(projectId, targetUserId)
    .run();

  return c.json({ removed: true });
});
```

- [ ] **Step 16.4: Run, expect pass.**

```bash
npx vitest run src/tests/project-members.test.ts
npm test -- --run
```

Expected: PASS, full suite green.

- [ ] **Step 16.5: Commit.**

```bash
git add src/routes/projects.ts src/tests/project-members.test.ts
git commit -m "feat(server): DELETE /projects/:id/members/:userId

409 with hint when the user has no direct row — that means access is
inherited from the org, and removal must happen there."
```

---

### Task 17: Server smoke test against local D1

- [ ] **Step 17.1: Start the dev server.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npm run dev
```

In another terminal, capture an auth token using the existing test register/login flow (look at `scripts/` or use a helper similar to the e2e setup). Then exercise the new endpoints with curl:

```bash
TOKEN=...  # from a /api/v2/auth/token call
BASE=http://127.0.0.1:8787

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v2/orgs/me"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v2/users/lookup?username=ghost" -i
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v2/projects/<some-project-id>/members"
```

Expected: `/orgs/me` returns 200 with `{id, name, role}`; lookup of nonexistent user is 404; project members returns 200 + array (or 403 if no access). Sanity-check shapes match the spec.

- [ ] **Step 17.2: Stop the dev server.** No commit needed.

---

## Phase 3 — Web app API wrappers

### Task 18: `src/lib/frontier/members.ts` typed wrappers

**Files:**
- Create: `src/lib/frontier/members.ts`
- Create: `src/lib/frontier/members.test.ts`

- [ ] **Step 18.1: Write the failing test.**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupUser,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
  type ProjectMember,
} from "./members";

const ORIG = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIG;
});

describe("lookupUser", () => {
  it("returns user on 200", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 7, username: "anna" }), { status: 200 })
    );
    const result = await lookupUser("jwt", "anna");
    expect(result).toEqual({ id: 7, username: "anna" });
  });

  it("returns null on 404", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("", { status: 404 }));
    const result = await lookupUser("jwt", "ghost");
    expect(result).toBeNull();
  });
});

describe("listProjectMembers", () => {
  it("returns members array", async () => {
    const members: ProjectMember[] = [
      { userId: 1, username: "wendy", role: { level: 700, name: "owner", source: "creator" } },
    ];
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ members }), { status: 200 })
    );
    const result = await listProjectMembers("jwt", "p1");
    expect(result).toEqual(members);
  });
});

describe("addProjectMember", () => {
  it("POSTs username + role", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 11, username: "clayton", role: { level: 400, name: "contributor", source: "override" } }), { status: 200 })
    );
    const result = await addProjectMember("jwt", "p1", "clayton", 400);
    expect(result.username).toBe("clayton");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/projects/p1/members"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "clayton", role: 400 }),
      })
    );
  });
});

describe("removeProjectMember", () => {
  it("DELETEs by user id", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 })
    );
    await removeProjectMember("jwt", "p1", 11);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/projects/p1/members/11"),
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
```

- [ ] **Step 18.2: Run, expect failure.**

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
npx vitest run src/lib/frontier/members.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 18.3: Implement.**

Create `src/lib/frontier/members.ts`:

```ts
import { FRONTIER_BASE } from "./auth";

export interface LookedUpUser {
  id: number;
  username: string;
}

export interface ProjectMemberRole {
  level: number;
  name: string;
  source: "override" | "creator" | "org";
}

export interface ProjectMember {
  userId: number;
  username: string;
  role: ProjectMemberRole;
}

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  };
}

export async function lookupUser(jwt: string, username: string): Promise<LookedUpUser | null> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/users/lookup?username=${encodeURIComponent(username)}`,
    { headers: authHeaders(jwt) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookupUser failed: HTTP ${res.status}`);
  return (await res.json()) as LookedUpUser;
}

export async function listProjectMembers(jwt: string, projectId: string): Promise<ProjectMember[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) throw new Error(`listProjectMembers failed: HTTP ${res.status}`);
  const body = (await res.json()) as { members: ProjectMember[] };
  return body.members;
}

export async function addProjectMember(
  jwt: string,
  projectId: string,
  username: string,
  role: number
): Promise<ProjectMember> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ username, role }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addProjectMember failed: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as ProjectMember;
}

export async function removeProjectMember(
  jwt: string,
  projectId: string,
  userId: number
): Promise<void> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members/${userId}`,
    { method: "DELETE", headers: authHeaders(jwt) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`removeProjectMember failed: HTTP ${res.status} — ${text}`);
  }
}
```

- [ ] **Step 18.4: Run, expect pass.**

```bash
npx vitest run src/lib/frontier/members.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 18.5: Commit.**

```bash
git add src/lib/frontier/members.ts src/lib/frontier/members.test.ts
git commit -m "feat(client): typed wrappers for project member endpoints"
```

---

### Task 19: `src/lib/frontier/orgs.ts` typed wrappers

**Files:**
- Create: `src/lib/frontier/orgs.ts`
- Create: `src/lib/frontier/orgs.test.ts`

- [ ] **Step 19.1: Write the failing test.**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOrCreateMyOrg,
  listOrgMembers,
  addOrgMember,
  removeOrgMember,
  listOrgMemberProjects,
} from "./orgs";

const ORIG = global.fetch;
beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { global.fetch = ORIG; });

describe("getOrCreateMyOrg", () => {
  it("returns org from /orgs/me", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 5, name: "anna", role: { level: 700, name: "owner" } }), { status: 200 })
    );
    const org = await getOrCreateMyOrg("jwt");
    expect(org.id).toBe(5);
    expect(org.role.level).toBe(700);
  });
});

describe("listOrgMembers", () => {
  it("returns members from GET", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [{ userId: 1, username: "wendy", role: { level: 700, name: "owner" } }] }), { status: 200 })
    );
    const members = await listOrgMembers("jwt", 5);
    expect(members).toHaveLength(1);
  });
});

describe("addOrgMember", () => {
  it("POSTs username + role", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: 7, username: "anna", role: { level: 600, name: "maintainer" } }), { status: 200 })
    );
    const result = await addOrgMember("jwt", 5, "anna", 600);
    expect(result.username).toBe("anna");
  });
});

describe("removeOrgMember", () => {
  it("DELETEs by user id", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 })
    );
    await removeOrgMember("jwt", 5, 11);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/orgs/5/members/11"),
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

describe("listOrgMemberProjects", () => {
  it("returns project list", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ projects: [{ id: "p1", name: "P1", role: { level: 400, name: "contributor" } }] }), { status: 200 })
    );
    const projects = await listOrgMemberProjects("jwt", 5, 11);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("p1");
  });
});
```

- [ ] **Step 19.2: Run, expect failure.**

- [ ] **Step 19.3: Implement.**

Create `src/lib/frontier/orgs.ts`:

```ts
import { FRONTIER_BASE } from "./auth";

export interface OrgRole {
  level: number;
  name: string;
}

export interface MyOrg {
  id: number;
  name: string | null;
  role: OrgRole;
}

export interface OrgMember {
  userId: number;
  username: string;
  role: OrgRole;
}

export interface OrgMemberProject {
  id: string;
  name: string;
  role: OrgRole;
}

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` };
}

export async function getOrCreateMyOrg(jwt: string): Promise<MyOrg> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/me`, { headers: authHeaders(jwt) });
  if (!res.ok) throw new Error(`getOrCreateMyOrg failed: HTTP ${res.status}`);
  return (await res.json()) as MyOrg;
}

export async function listOrgMembers(jwt: string, orgId: number): Promise<OrgMember[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    headers: authHeaders(jwt),
  });
  if (!res.ok) throw new Error(`listOrgMembers failed: HTTP ${res.status}`);
  return ((await res.json()) as { members: OrgMember[] }).members;
}

export async function addOrgMember(
  jwt: string, orgId: number, username: string, role: number
): Promise<OrgMember> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ username, role }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`addOrgMember failed: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as OrgMember;
}

export async function removeOrgMember(
  jwt: string, orgId: number, userId: number
): Promise<void> {
  const res = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`removeOrgMember failed: HTTP ${res.status} — ${text}`);
  }
}

export async function listOrgMemberProjects(
  jwt: string, orgId: number, userId: number
): Promise<OrgMemberProject[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/members/${userId}/projects`,
    { headers: authHeaders(jwt) }
  );
  if (!res.ok) throw new Error(`listOrgMemberProjects failed: HTTP ${res.status}`);
  return ((await res.json()) as { projects: OrgMemberProject[] }).projects;
}
```

- [ ] **Step 19.4: Run, expect pass.**

```bash
npx vitest run src/lib/frontier/orgs.test.ts
```

- [ ] **Step 19.5: Commit.**

```bash
git add src/lib/frontier/orgs.ts src/lib/frontier/orgs.test.ts
git commit -m "feat(client): typed wrappers for org endpoints"
```

---

### Task 20: `useProjectMembers` hook

**Files:**
- Create: `src/hooks/useProjectMembers.ts`

- [ ] **Step 20.1: Implement (no test — covered by component-level tests in later tasks).**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listProjectMembers, addProjectMember, removeProjectMember,
  lookupUser,
  type ProjectMember,
} from "@/lib/frontier/members";
import { useFrontierSession } from "./useFrontierSession";

export interface UseProjectMembers {
  members: ProjectMember[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Returns null if username not found, otherwise the new/upserted member. */
  add: (username: string, role: number) => Promise<ProjectMember | null>;
  remove: (userId: number) => Promise<void>;
  /** Same as add — server upserts. Convenience for renaming the call site. */
  changeRole: (username: string, role: number) => Promise<ProjectMember | null>;
}

export function useProjectMembers(projectId: string | null): UseProjectMembers {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listProjectMembers(jwt, projectId);
      if (aliveRef.current) setMembers(next);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [jwt, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (username: string, role: number) => {
    if (!jwt || !projectId) return null;
    const found = await lookupUser(jwt, username);
    if (!found) return null;
    const next = await addProjectMember(jwt, projectId, username, role);
    await refresh();
    return next;
  }, [jwt, projectId, refresh]);

  const remove = useCallback(async (userId: number) => {
    if (!jwt || !projectId) return;
    await removeProjectMember(jwt, projectId, userId);
    await refresh();
  }, [jwt, projectId, refresh]);

  return { members, isLoading, error, refresh, add, remove, changeRole: add };
}
```

- [ ] **Step 20.2: Typecheck.**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 20.3: Commit.**

```bash
git add src/hooks/useProjectMembers.ts
git commit -m "feat(client): useProjectMembers hook"
```

---

### Task 21: `useOrg` hooks

**Files:**
- Create: `src/hooks/useOrg.ts`

- [ ] **Step 21.1: Implement.**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrCreateMyOrg, listOrgMembers, addOrgMember, removeOrgMember,
  listOrgMemberProjects, type MyOrg, type OrgMember, type OrgMemberProject,
} from "@/lib/frontier/orgs";
import { useFrontierSession } from "./useFrontierSession";

export function useOrg() {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [org, setOrg] = useState<MyOrg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    if (!jwt) {
      setOrg(null);
      return;
    }
    let cancelled = false;
    getOrCreateMyOrg(jwt)
      .then((o) => { if (!cancelled && aliveRef.current) setOrg(o); })
      .catch((e) => { if (!cancelled && aliveRef.current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [jwt]);

  return { org, error };
}

export interface UseOrgMembers {
  members: OrgMember[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (username: string, role: number) => Promise<OrgMember | null>;
  remove: (userId: number) => Promise<void>;
  /** For the remove-confirmation flow: list a member's direct project memberships. */
  listMemberProjects: (userId: number) => Promise<OrgMemberProject[]>;
}

export function useOrgMembers(orgId: number | null): UseOrgMembers {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!jwt || orgId == null) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listOrgMembers(jwt, orgId);
      if (aliveRef.current) setMembers(next);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [jwt, orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (username: string, role: number) => {
    if (!jwt || orgId == null) return null;
    try {
      const next = await addOrgMember(jwt, orgId, username, role);
      await refresh();
      return next;
    } catch {
      return null;
    }
  }, [jwt, orgId, refresh]);

  const remove = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return;
    await removeOrgMember(jwt, orgId, userId);
    await refresh();
  }, [jwt, orgId, refresh]);

  const listMemberProjects = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return [];
    return listOrgMemberProjects(jwt, orgId, userId);
  }, [jwt, orgId]);

  return { members, isLoading, error, refresh, add, remove, listMemberProjects };
}
```

- [ ] **Step 21.2: Typecheck.**

```bash
npx tsc --noEmit
```

- [ ] **Step 21.3: Commit.**

```bash
git add src/hooks/useOrg.ts
git commit -m "feat(client): useOrg + useOrgMembers hooks"
```

---

## Phase 4 — Web app UI

### Task 22: `MembershipAvatars` component

**Files:**
- Create: `src/components/MembershipAvatars.tsx`
- Create: `src/components/MembershipAvatars.test.tsx`

- [ ] **Step 22.1: Write the failing test.**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MembershipAvatars } from "./MembershipAvatars";

const members = [
  { userId: 1, username: "wendy", role: { level: 700, name: "owner", source: "creator" as const } },
  { userId: 2, username: "anna", role: { level: 600, name: "maintainer", source: "org" as const } },
  { userId: 3, username: "clayton", role: { level: 400, name: "contributor", source: "override" as const } },
  { userId: 4, username: "valerie", role: { level: 400, name: "contributor", source: "override" as const } },
  { userId: 5, username: "amir", role: { level: 400, name: "contributor", source: "override" as const } },
];

describe("MembershipAvatars", () => {
  it("renders up to maxVisible avatars and an overflow chip", () => {
    render(<MembershipAvatars members={members} maxVisible={3} />);
    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("renders nothing for empty list", () => {
    const { container } = render(<MembershipAvatars members={[]} maxVisible={3} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders no overflow chip when count <= maxVisible", () => {
    render(<MembershipAvatars members={members.slice(0, 2)} maxVisible={3} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});
```

- [ ] **Step 22.2: Run, expect failure.**

```bash
npx vitest run src/components/MembershipAvatars.test.tsx
```

- [ ] **Step 22.3: Implement.**

```tsx
import type { ProjectMember } from "@/lib/frontier/members";

interface MembershipAvatarsProps {
  members: ProjectMember[];
  maxVisible?: number;
}

function getInitial(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return "?";
  return trimmed[0].toUpperCase();
}

// Match the color hash style used by PeerPresence — keep avatars consistent
// with the in-project presence UI.
function colorFor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 50%)`;
}

export function MembershipAvatars({ members, maxVisible = 4 }: MembershipAvatarsProps) {
  if (members.length === 0) return null;
  const visible = members.slice(0, maxVisible);
  const overflow = members.length - visible.length;

  return (
    <div className="flex -space-x-1.5" title={`${members.length} member${members.length !== 1 ? "s" : ""}`}>
      {visible.map((m) => (
        <div
          key={m.userId}
          title={`${m.username} (${m.role.name})`}
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
          style={{ backgroundColor: colorFor(m.username) }}
        >
          {getInitial(m.username)}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
          +{overflow}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 22.4: Run, expect pass.**

```bash
npx vitest run src/components/MembershipAvatars.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 22.5: Commit.**

```bash
git add src/components/MembershipAvatars.tsx src/components/MembershipAvatars.test.tsx
git commit -m "feat(client): MembershipAvatars component"
```

---

### Task 23: Avatar stack on `ProjectCard`

**Files:**
- Modify: `src/components/ProjectCard.tsx`

- [ ] **Step 23.1: Add the avatar stack.**

In `src/components/ProjectCard.tsx`, import the new component and the hook, and render the avatars inside the card content (only for active variant — trashed cards keep the old layout):

```tsx
import { MembershipAvatars } from "./MembershipAvatars";
import { useProjectMembers } from "@/hooks/useProjectMembers";
```

In the component body, before the return, add:

```tsx
const { members } = useProjectMembers(isTrashed ? null : project.id);
```

In the active card's `<CardContent>`, after the existing two `<p>` paragraphs, render:

```tsx
{!isTrashed && members.length > 0 && (
  <div className="mt-2">
    <MembershipAvatars members={members} maxVisible={4} />
  </div>
)}
```

- [ ] **Step 23.2: Manual verification — start dev server.**

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
npm run dev
```

(Use `preview_start` if working in Claude Preview environment.)

Open the dashboard, sign in, look at any cloud project. Confirm the avatar stack renders for projects you have access to, with at least your own initial. If `useProjectMembers` 403s on a project, verify it doesn't crash the card — `members` stays `[]` and the section is hidden.

- [ ] **Step 23.3: Commit.**

```bash
git add src/components/ProjectCard.tsx
git commit -m "feat(client): avatar stack on dashboard project cards"
```

---

### Task 24: `MembersPanel` reusable component

**Files:**
- Create: `src/components/MembersPanel.tsx`

The same UI is used in SharePanel (for project members) and OrgSettings (for org members). Parameterize the data source and the role bounds via props.

- [ ] **Step 24.1: Implement.**

```tsx
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface MembersPanelMember {
  userId: number;
  username: string;
  roleLevel: number;
  roleName: string;
  source: "override" | "creator" | "org" | "owner-of-org";
  /** True when removing this row is not possible from this UI surface. */
  isLocked: boolean;
  lockedHint?: string;
}

export interface MembersPanelRoleOption {
  level: number;
  name: string;
  description: string;
}

interface MembersPanelProps {
  members: MembersPanelMember[];
  roleOptions: MembersPanelRoleOption[];
  defaultRole: number;
  onAdd: (username: string, role: number) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (userId: number) => Promise<void>;
  onChangeRole?: (username: string, role: number) => Promise<void>;
  /** Caller's own user id, used to block self-edit affordances. */
  callerUserId: number | null;
  /** Highest role the caller can grant (caps the role dropdown). */
  callerMaxRole: number;
}

export function MembersPanel({
  members, roleOptions, defaultRole,
  onAdd, onRemove, onChangeRole,
  callerUserId, callerMaxRole,
}: MembersPanelProps) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState(defaultRole);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    if (!username.trim()) return;
    setAdding(true);
    setAddError(null);
    const result = await onAdd(username.trim(), role);
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "Could not add user");
      return;
    }
    setUsername("");
    setRole(defaultRole);
  }

  const grantableRoles = roleOptions.filter((r) => r.level <= callerMaxRole);

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded border">
        {members.map((m) => {
          const isSelf = m.userId === callerUserId;
          return (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">{m.username}</span>
              <span className="text-xs text-muted-foreground">{m.roleName}</span>
              {m.source === "org" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">via org</span>
              )}
              {m.source === "creator" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">creator</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {onChangeRole && !m.isLocked && !isSelf && (
                  <select
                    className="rounded border bg-background px-2 py-1 text-xs"
                    value={m.roleLevel}
                    onChange={(e) => onChangeRole(m.username, parseInt(e.target.value, 10))}
                  >
                    {grantableRoles.map((r) => (
                      <option key={r.level} value={r.level}>{r.name}</option>
                    ))}
                  </select>
                )}
                {!m.isLocked && !isSelf ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${m.username}`}
                    onClick={() => onRemove(m.userId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : (
                  <span className="text-[10px] text-muted-foreground" title={m.lockedHint}>
                    {m.lockedHint ?? ""}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={adding}
            autoComplete="off"
          />
          <select
            className="rounded border bg-background px-2 text-sm"
            value={role}
            onChange={(e) => setRole(parseInt(e.target.value, 10))}
            disabled={adding}
          >
            {grantableRoles.map((r) => (
              <option key={r.level} value={r.level}>{r.name}</option>
            ))}
          </select>
          <Button onClick={handleAdd} disabled={adding || !username.trim()}>
            Add
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 24.2: Typecheck.**

```bash
npx tsc --noEmit
```

- [ ] **Step 24.3: Commit.**

```bash
git add src/components/MembersPanel.tsx
git commit -m "feat(client): MembersPanel reusable list/add UI"
```

---

### Task 25: Members tab in `SharePanel`

**Files:**
- Modify: `src/components/SharePanel.tsx`

- [ ] **Step 25.1: Add a tabbed layout.**

At the top of the panel, render a small tab strip with **Members** (default) and **Invite link** (existing UI). Use plain conditional rendering or shadcn Tabs if available — match the style used elsewhere.

```tsx
const [tab, setTab] = useState<"members" | "link">("members");
```

Render in `<DialogContent>`:

```tsx
<div className="mb-3 flex gap-2 border-b">
  <button
    type="button"
    onClick={() => setTab("members")}
    className={`px-3 py-1.5 text-sm ${tab === "members" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
  >
    Members
  </button>
  <button
    type="button"
    onClick={() => setTab("link")}
    className={`px-3 py-1.5 text-sm ${tab === "link" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
  >
    Invite link
  </button>
</div>

{tab === "members" ? (
  <MembersTab projectId={projectId} />
) : (
  <InviteLinkTab /* existing JSX wrapped in a sub-component or kept inline */ />
)}
```

Move the existing share-link JSX into an inline `InviteLinkTab` component or render it conditionally — whichever keeps the diff readable.

- [ ] **Step 25.2: Implement `MembersTab`.**

In the same file (or a sibling), add:

```tsx
import { useProjectMembers } from "@/hooks/useProjectMembers";
import { MembersPanel, type MembersPanelMember } from "./MembersPanel";
import { useFrontierSession } from "@/hooks/useFrontierSession";

const PROJECT_ROLE_OPTIONS = [
  { level: 100, name: "viewer", description: "Read-only" },
  { level: 200, name: "commenter", description: "Read + comments" },
  { level: 300, name: "reviewer", description: "Read + validate" },
  { level: 400, name: "contributor", description: "Read + edit" },
  { level: 500, name: "project_lead", description: "Contributor + manage members" },
  { level: 600, name: "maintainer", description: "Lead + manage roles" },
];

function MembersTab({ projectId }: { projectId: string }) {
  const { session } = useFrontierSession();
  const callerUserId = session?.userId ?? null;
  const callerMaxRole = 600; // Server enforces; we permit the full grantable range.

  const { members, isLoading, error, add, remove } = useProjectMembers(projectId);

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.source,
    isLocked: m.role.source === "org" || m.role.source === "creator",
    lockedHint:
      m.role.source === "org"
        ? "Remove from org to revoke"
        : m.role.source === "creator"
        ? "Project creator"
        : undefined,
  }));

  return (
    <div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {isLoading && members.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <MembersPanel
          members={panelMembers}
          roleOptions={PROJECT_ROLE_OPTIONS}
          defaultRole={400}
          callerUserId={callerUserId}
          callerMaxRole={callerMaxRole}
          onAdd={async (username, role) => {
            const result = await add(username, role);
            return result ? { ok: true } : { ok: false, error: "No user with that username" };
          }}
          onRemove={remove}
          onChangeRole={async (username, role) => { await add(username, role); }}
        />
      )}
    </div>
  );
}
```

Note: if `session.userId` doesn't exist on the session type, derive it from `username` lookup or skip the self-block (server enforces self-grant rejection regardless). If TypeScript complains, look at `src/lib/frontier/types.ts` for `FrontierSession` shape and adapt — pass `null` as `callerUserId` if no id is available.

- [ ] **Step 25.3: Manual verification.**

Open the dev server, click Share on a project. Verify the Members tab is the default and lists at least the creator. Try adding a member by username (use a known existing test user). Verify it appears in the list.

- [ ] **Step 25.4: Commit.**

```bash
git add src/components/SharePanel.tsx
git commit -m "feat(client): Members tab in SharePanel"
```

---

### Task 26: Org Settings page

**Files:**
- Create: `src/pages/OrgSettings.tsx`
- Modify: `src/App.tsx` (or wherever `<Routes>` is declared) to add `/settings/org`
- Modify: `src/components/Dashboard.tsx` to add a nav link

- [ ] **Step 26.1: Find the router definition.**

Run: `grep -n "BrowserRouter\|<Routes>\|<Route " src/`

Identify the file that declares routes (likely `src/App.tsx` or `src/main.tsx`).

- [ ] **Step 26.2: Implement the page.**

```tsx
import { useState } from "react";
import { useOrg, useOrgMembers } from "@/hooks/useOrg";
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel";
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog";
import { useFrontierSession } from "@/hooks/useFrontierSession";

const ORG_ROLE_OPTIONS = [
  { level: 100, name: "viewer", description: "Read-only across all projects" },
  { level: 400, name: "contributor", description: "Edit content across all projects" },
  { level: 500, name: "project_lead", description: "Manage members on every project" },
  { level: 600, name: "maintainer", description: "Lead + manage roles" },
];

export function OrgSettings() {
  const { session } = useFrontierSession();
  const callerUserId = session?.userId ?? null;
  const { org, error: orgError } = useOrg();
  const { members, error: listError, add, remove, listMemberProjects, refresh } = useOrgMembers(org?.id ?? null);

  const [removeTarget, setRemoveTarget] = useState<{ userId: number; username: string } | null>(null);

  if (orgError) return <p className="p-4 text-destructive">{orgError}</p>;
  if (!org) return <p className="p-4 text-muted-foreground">Loading…</p>;

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.level === 700 ? "owner-of-org" : "override",
    isLocked: m.role.level === 700, // owner can't be removed
    lockedHint: m.role.level === 700 ? "Org owner" : undefined,
  }));

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-xl font-semibold">{org.name ?? "Organization"}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Members here have access to every project in the organization at the role you set.
      </p>
      {listError && <p className="mb-2 text-xs text-destructive">{listError}</p>}
      <MembersPanel
        members={panelMembers}
        roleOptions={ORG_ROLE_OPTIONS}
        defaultRole={600}
        callerUserId={callerUserId}
        callerMaxRole={600}
        onAdd={async (username, role) => {
          const result = await add(username, role);
          return result ? { ok: true } : { ok: false, error: "Could not add user. Username may not exist." };
        }}
        onRemove={(userId) => {
          const target = members.find((m) => m.userId === userId);
          if (target) setRemoveTarget({ userId: target.userId, username: target.username });
          return Promise.resolve();
        }}
        onChangeRole={async (username, role) => { await add(username, role); }}
      />

      {removeTarget && (
        <RemoveOrgMemberDialog
          orgId={org.id}
          orgName={org.name ?? "the organization"}
          userId={removeTarget.userId}
          username={removeTarget.username}
          listProjects={() => listMemberProjects(removeTarget.userId)}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={async () => {
            await remove(removeTarget.userId);
            await refresh();
            setRemoveTarget(null);
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 26.3: Mount the route.**

In `src/App.tsx` (adapt to actual file), add:

```tsx
import { OrgSettings } from "./pages/OrgSettings";
// ...inside <Routes>:
<Route path="/settings/org" element={<OrgSettings />} />
```

If `pages/` doesn't exist, create the directory or place the file under `src/components/` to match local convention.

- [ ] **Step 26.4: Add a nav entry.**

In `src/components/Dashboard.tsx`, find the header bar (the row with `<HeaderAuth>`). Add a link:

```tsx
import { Link } from "react-router-dom";
// ...
<Link to="/settings/org" className="text-sm underline-offset-2 hover:underline">
  Organization
</Link>
```

- [ ] **Step 26.5: Commit (without RemoveOrgMemberDialog yet — this commit will fail typecheck on the dialog import; see next task to follow immediately).**

Skip this commit step. Combine into one commit after Task 27.

---

### Task 27: `RemoveOrgMemberDialog`

**Files:**
- Create: `src/components/RemoveOrgMemberDialog.tsx`

- [ ] **Step 27.1: Implement.**

```tsx
import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { removeProjectMember } from "@/lib/frontier/members";
import { useFrontierSession } from "@/hooks/useFrontierSession";
import type { OrgMemberProject } from "@/lib/frontier/orgs";

interface RemoveOrgMemberDialogProps {
  orgId: number;
  orgName: string;
  userId: number;
  username: string;
  listProjects: () => Promise<OrgMemberProject[]>;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}

export function RemoveOrgMemberDialog({
  orgName, userId, username, listProjects, onClose, onConfirmed,
}: RemoveOrgMemberDialogProps) {
  const { session } = useFrontierSession();
  const [projects, setProjects] = useState<OrgMemberProject[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((p) => { if (!cancelled) { setProjects(p); setLoading(false); } })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [listProjects]);

  function toggle(id: string) {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    if (!session?.jwt) return;
    setSubmitting(true);
    setError(null);
    try {
      // Remove from each opted-in project first, so partial failures still
      // leave the org membership intact for retry.
      for (const projectId of checked) {
        await removeProjectMember(session.jwt, projectId, userId);
      }
      await onConfirmed(); // org-side removal
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const checkedCount = checked.size;
  const buttonLabel = checkedCount > 0
    ? `Remove from org and ${checkedCount} project${checkedCount === 1 ? "" : "s"}`
    : "Remove from org";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {username} from {orgName}?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            {username} will lose org-wide access. They will still keep access to any
            projects they were added to individually unless you also remove them below.
          </p>
          {loading && <p className="text-muted-foreground">Loading projects…</p>}
          {!loading && projects && projects.length === 0 && (
            <p className="text-muted-foreground">No direct project memberships in this org.</p>
          )}
          {!loading && projects && projects.length > 0 && (
            <ul className="space-y-1 rounded border p-2">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`rm-${p.id}`}
                    checked={checked.has(p.id)}
                    onChange={() => toggle(p.id)}
                    disabled={submitting}
                  />
                  <label htmlFor={`rm-${p.id}`} className="flex-1 cursor-pointer">
                    {p.name} <span className="text-xs text-muted-foreground">({p.role.name})</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 27.2: Typecheck both files together.**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 27.3: Commit Tasks 26 + 27 together.**

```bash
git add src/pages/OrgSettings.tsx src/components/RemoveOrgMemberDialog.tsx src/App.tsx src/components/Dashboard.tsx
git commit -m "feat(client): Org Settings page with remove-from-org confirmation

Adds the /settings/org route, wires the MembersPanel against the org
endpoints, and confirms member removal with an opt-in checkbox list of
their direct project memberships."
```

If `src/App.tsx` wasn't the right routes file, swap in whichever file declares `<Routes>`.

---

### Task 28: End-to-end manual verification

- [ ] **Step 28.1: Start frontier-server local dev.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare
npm run dev
```

- [ ] **Step 28.2: Start codex-web-app dev (ensure it points at local frontier).**

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
npm run dev
```

If FRONTIER_BASE is hardcoded to production in `src/lib/frontier/auth.ts`, temporarily point it at `http://127.0.0.1:8787`. Don't commit that change.

- [ ] **Step 28.3: Walk the spec's Wendy/Anna/Clayton flow.**

1. Sign up two new users (e.g. `wendy_test`, `anna_test`, `clayton_test`).
2. As `wendy_test`: visit `/settings/org`, confirm "wendy_test's workspace" was lazy-created and Wendy is owner.
3. Add `anna_test` at maintainer (600).
4. Create a new project. Confirm dashboard avatar stack shows Wendy + Anna.
5. Sign in as `anna_test`. Confirm the project appears on her dashboard. Open it, verify role.
6. As Anna: open the share modal Members tab, add `clayton_test` at contributor (400).
7. Sign in as `clayton_test`. Confirm only that one project is visible; opening it works at the granted role.
8. As Wendy: from `/settings/org`, click Remove next to Anna. Modal lists "no direct memberships" (Anna only inherited via org). Confirm. Anna loses access; Clayton's project access is preserved.
9. Add Anna back. Add her to the project directly with role 300 (override). Remove from org again — modal lists the override; toggle the checkbox; confirm. Clayton remains, Anna's project membership is gone.

- [ ] **Step 28.4: Run the full test suites one more time.**

```bash
cd /Users/ryderwishart/frontierrnd/frontier-server/cloudflare && npm test -- --run
cd /Users/ryderwishart/prototypes/codex-web-app && npx vitest run
```

Expected: all green.

- [ ] **Step 28.5: No commit required if everything passed.**

If you fixed bugs during verification, commit each fix as its own commit with a message that states what regressed and how you fixed it.

---

## Out of scope (do not build)

These are listed in the spec under Non-Goals — leave them alone:

- Online presence on dashboard avatars
- Email-based invites or pending-user invites
- Multi-org / org switcher
- Nested groups / sub-teams
- Org rename UI (`PUT /orgs/:id`)
- Migrating projects with `org_id IS NULL`
- Rate limiting on `/users/lookup`
- Batched `GET /projects/members?ids=…` endpoint (per-card fetches are fine for v1)

## Self-review

The plan was checked against the spec sections:

- **Direct add by username** — Tasks 14, 15, 18, 25 cover server, client wrapper, and UI.
- **Flat orgs + cascade tier 3** — Tasks 1, 6, 9–13 cover schema, resolver, and CRUD endpoints.
- **Lazy-created personal orgs without Stripe** — Tasks 2, 5, 9.
- **Effective members listing** — Task 14 + service helper.
- **Avatar stack** — Tasks 22, 23.
- **Members tab in SharePanel** — Task 25.
- **Org Settings + remove-from-org dialog** — Tasks 26, 27.
- **Existing link/PIN flow unchanged** — verified by leaving `POST /api/v2/projects/:id/invites` and `POST /api/v2/projects/accept-invite` untouched.
- **Permission cascade ordering** (project_members > creator > org > gitlab) — Task 6 test cases assert tier precedence.
- **409 on org-only DELETE** — Task 16.
- **Three-legged stool** — verified by Tasks 14 (effective listing), 15 (project-only add).

No placeholders, no "TBD", every step has either runnable code or a runnable command with expected output.
