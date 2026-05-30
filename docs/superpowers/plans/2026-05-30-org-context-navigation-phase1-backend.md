# Org Context & Navigation — Phase 1 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `auth-worker` endpoints the org-context UI needs: list the orgs a user belongs to, scope/label the projects list by org, gate project creation as an org-level function, and expose read-only group ("Teams") data.

**Architecture:** Five tasks against the Hono `auth-worker` (`export default app`, called as `app.request(url, init, env)`). New SQL spans the existing `organizations` / `org_members` / `groups` / `group_members` / `group_project_grants` tables (migrations `0001` + `0007`). Role resolution (AD-12 max-wins) already lives in `routes/projects.ts`; we extend the projects list and add new org/group reads.

**Tech Stack:** TypeScript, Hono, Cloudflare D1, Vitest. **Tests run against real D1 via `@cloudflare/vitest-pool-workers`** (decided 2026-05-30 — the prior hand-rolled `d1-fake.ts` can't express the union/join queries here and doesn't cover the projects-list query at all). The fake-based tests are migrated onto the real-D1 harness in Task 1.

**Spec:** [docs/superpowers/specs/2026-05-30-org-context-navigation-design.md](../specs/2026-05-30-org-context-navigation-design.md). The client plan is a separate document (next).

---

## File Structure

- `auth-worker/vitest.config.ts` — **replace** node-env + fake config with `defineWorkersConfig` (real D1).
- `auth-worker/src/__tests__/helpers/d1.ts` — **new** real-D1 test helpers (`seedUser`, `jwtFor`).
- `auth-worker/src/__tests__/env.d.ts` — **new** `cloudflare:test` `ProvidedEnv` typing.
- `auth-worker/src/__tests__/setup-migrations.ts` — **new** applies migrations before tests.
- `auth-worker/src/services/org-permissions.ts` — **modify** add `listUserOrgs`, `listOrgGroups`, `getOrgGroupDetail`.
- `auth-worker/src/routes/orgs.ts` — **modify** add `GET /`, `GET /:orgId/groups`, `GET /:orgId/groups/:groupId`.
- `auth-worker/src/routes/projects.ts` — **modify** add `org_id` to the list response + `?orgId` filter; gate `POST /projects` on org role ≥ maintainer.
- `auth-worker/src/__tests__/orgs-list.test.ts`, `groups-read.test.ts`, `projects-org-scope.test.ts` — **new** tests.

Each task ends with a commit. Run worker tests from the worker dir: `cd auth-worker && npx vitest run <path>`.

---

### Task 1: Real-D1 test harness (`@cloudflare/vitest-pool-workers`)

**Files:**
- Modify: `auth-worker/vitest.config.ts`
- Create: `auth-worker/src/__tests__/setup-migrations.ts`
- Create: `auth-worker/src/__tests__/env.d.ts`
- Create: `auth-worker/src/__tests__/helpers/d1.ts`
- Create: `auth-worker/src/__tests__/d1-harness.test.ts`

- [ ] **Step 1: Install the pool**

Run: `cd auth-worker && npm install -D @cloudflare/vitest-pool-workers`
Expected: dependency added to `auth-worker/package.json`.

- [ ] **Step 2: Replace the vitest config**

Replace `auth-worker/vitest.config.ts` with:

```ts
import path from "node:path"
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"))
  return {
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["./src/__tests__/setup-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true, // per-test storage fork; no manual reset needed
          miniflare: {
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: { AQUILLA_DB: "test-aquilla-db" },
            bindings: {
              TEST_MIGRATIONS: migrations,
              SECRET_KEY: "frontier-test-secret",
              ALGORITHM: "HS256",
              ACCESS_TOKEN_EXPIRE_MINUTES: "60",
              SYNC_SECRET_KEY: "sync-secret",
            },
          },
        },
      },
    },
  }
})
```

(If `compatibilityDate` mismatches `wrangler.toml`, align it to the value there.)

- [ ] **Step 3: Migration setup file**

Create `auth-worker/src/__tests__/setup-migrations.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test"
import { beforeAll } from "vitest"

// Applies every migration in auth-worker/migrations into the test D1 once;
// isolatedStorage forks this migrated baseline per test.
beforeAll(async () => {
  await applyD1Migrations(env.AQUILLA_DB, env.TEST_MIGRATIONS)
})
```

- [ ] **Step 4: Test env typing**

Create `auth-worker/src/__tests__/env.d.ts`:

```ts
import type { D1Migration } from "cloudflare:test"
import type { Env } from "../types"

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
  }
}
```

- [ ] **Step 5: Test helpers**

Create `auth-worker/src/__tests__/helpers/d1.ts`:

```ts
import { env } from "cloudflare:test"
import { sign } from "hono/jwt"

/** Insert a minimal users row. created_at/updated_at use schema defaults. */
export async function seedUser(id: number, username: string): Promise<void> {
  await env.AQUILLA_DB.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (?, ?, ?, ?, '{}')",
  )
    .bind(id, username, `${username}@example.com`, "scrypt:fake$salt$hash")
    .run()
}

/** Frontier JWT signed with the test SECRET_KEY (sub = username). */
export async function jwtFor(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600 }, env.SECRET_KEY, "HS256")
}

export function authHeader(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}
```

- [ ] **Step 6: Write the harness smoke test**

Create `auth-worker/src/__tests__/d1-harness.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/d1"

describe("real-D1 harness", () => {
  it("applies migrations (org/group tables exist)", async () => {
    const tables = await env.AQUILLA_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('organizations','org_members','groups','group_members','group_project_grants')",
    ).all<{ name: string }>()
    const names = (tables.results ?? []).map((r) => r.name).sort()
    expect(names).toEqual([
      "group_members",
      "group_project_grants",
      "groups",
      "org_members",
      "organizations",
    ])
  })

  it("isolates storage between tests (seed visible here only)", async () => {
    await seedUser(1, "alice")
    const row = await env.AQUILLA_DB.prepare("SELECT username FROM users WHERE id = 1").first<{ username: string }>()
    expect(row?.username).toBe("alice")
  })
})
```

- [ ] **Step 7: Run the smoke test**

Run: `cd auth-worker && npx vitest run src/__tests__/d1-harness.test.ts`
Expected: PASS (both tests).

- [ ] **Step 8: Migrate existing fake-based tests onto real D1**

The existing tests (`invites.test.ts`, `auth-routes.test.ts`, `sync-token.test.ts`) pass `makeEnv(makeFakeD1(...))` to `app.request`. Convert each to: seed via SQL (`env.AQUILLA_DB.prepare(...).run()`), use `jwtFor`, and pass the real `env`. Example conversion for the first `invites.test.ts` case:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("POST /api/v2/projects/:id/invites", () => {
  it("creates an invite for the project creator and caps role at contributor", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Test', NULL, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/proj-1/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ role: 700 }) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; role: number; token: string }
    expect(body.projectId).toBe("proj-1")
    expect(body.role).toBe(400)
    const invites = await env.AQUILLA_DB.prepare("SELECT token FROM project_invites WHERE project_id = 'proj-1'").all()
    expect(invites.results).toHaveLength(1)
  })
  // ... convert remaining cases the same way (seed rows via SQL, assert via SELECT).
})
```

Delete `auth-worker/src/__tests__/helpers/d1-fake.ts` once no test imports it.

- [ ] **Step 9: Run the full worker suite**

Run: `cd auth-worker && npx vitest run`
Expected: PASS (all converted + new tests).

- [ ] **Step 10: Commit**

```bash
git add auth-worker/vitest.config.ts auth-worker/src/__tests__ auth-worker/package.json auth-worker/package-lock.json
git commit -m "test(auth-worker): real-D1 test harness via vitest-pool-workers"
```

---

### Task 2: `GET /api/v2/orgs` — list the caller's orgs

**Files:**
- Modify: `auth-worker/src/services/org-permissions.ts`
- Modify: `auth-worker/src/routes/orgs.ts`
- Test: `auth-worker/src/__tests__/orgs-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `auth-worker/src/__tests__/orgs-list.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function getOrgs(username: string) {
  const res = await app.request("/api/v2/orgs", { headers: authHeader(await jwtFor(username)) }, env)
  return { status: res.status, body: (await res.json()) as { orgs: Array<{ id: number; name: string | null; role: { level: number; name: string } }> } }
}

describe("GET /api/v2/orgs", () => {
  it("returns owned + member orgs with resolved roles", async () => {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'annas workspace', 2)").run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (2, 2, 700, 2)",
    ).run()

    const { status, body } = await getOrgs("anna")
    expect(status).toBe(200)
    const byId = Object.fromEntries(body.orgs.map((o) => [o.id, o]))
    expect(byId[1].role.level).toBe(600) // Come and See, via membership
    expect(byId[1].name).toBe("Come and See")
    expect(byId[2].role.level).toBe(700) // own workspace
  })

  it("lazy-creates a personal org for a brand-new user", async () => {
    await seedUser(3, "newbie")
    const { status, body } = await getOrgs("newbie")
    expect(status).toBe(200)
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0].role.level).toBe(700)
    expect(body.orgs[0].name).toBe("newbie's workspace")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/orgs-list.test.ts`
Expected: FAIL — `GET /api/v2/orgs` returns 404 (route not defined).

- [ ] **Step 3: Add the `listUserOrgs` service**

In `auth-worker/src/services/org-permissions.ts`, after `getOrCreateUserOrg`, add:

```ts
export interface UserOrgSummary {
  id: number
  name: string | null
  role: number
}

/**
 * Every org the user belongs to: owned orgs (role 700) unioned with
 * org_members rows (role per row). Owner wins on conflict. Lazy-creates the
 * personal org if the user has none yet, so the switcher always has ≥1 entry.
 */
export async function listUserOrgs(env: Env, user: AuthUser): Promise<UserOrgSummary[]> {
  const byId = new Map<number, UserOrgSummary>()

  const owned = await env.AQUILLA_DB.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ?",
  )
    .bind(user.id)
    .all<{ id: number; name: string | null }>()
  for (const o of owned.results ?? []) {
    byId.set(o.id, { id: o.id, name: o.name, role: 700 })
  }

  const memberships = await env.AQUILLA_DB.prepare(
    `SELECT o.id AS id, o.name AS name, om.role_level AS role_level
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?`,
  )
    .bind(user.id)
    .all<{ id: number; name: string | null; role_level: number }>()
  for (const m of memberships.results ?? []) {
    const existing = byId.get(m.id)
    if (!existing || m.role_level > existing.role) {
      byId.set(m.id, { id: m.id, name: m.name, role: m.role_level })
    }
  }

  if (byId.size === 0) {
    const personal = await getOrCreateUserOrg(env, user)
    byId.set(personal.id, { id: personal.id, name: personal.name, role: personal.role })
  }

  return Array.from(byId.values()).sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  )
}
```

- [ ] **Step 4: Add the route**

In `auth-worker/src/routes/orgs.ts`, import `listUserOrgs` (add to the existing `from "../services/org-permissions"` import) and add this route immediately after the `orgs.use("*", authMiddleware)` line, before `GET /me`:

```ts
/** GET /api/v2/orgs — every org the caller belongs to (owned + member). */
orgs.get("/", async (c) => {
  const user = c.get("user")
  const list = await listUserOrgs(c.env, user)
  return c.json({
    orgs: list.map((o) => ({
      id: o.id,
      name: o.name,
      role: { level: o.role, name: ROLE_NAMES[o.role] ?? "unknown" },
    })),
  })
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/orgs-list.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/orgs-list.test.ts
git commit -m "feat(auth-worker): GET /api/v2/orgs lists owned + member orgs"
```

---

### Task 3: `org_id` on the projects list + `?orgId` filter

**Files:**
- Modify: `auth-worker/src/routes/projects.ts:197-269` (the `GET /` list query + response map)
- Test: `auth-worker/src/__tests__/projects-org-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `auth-worker/src/__tests__/projects-org-scope.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedTwoOrgProjects() {
  await seedUser(1, "wendi")
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1), (2, 'Side Org', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1), ('p2', 'Mark', 1, 1), ('p3', 'Side', 2, 1)").run()
}

describe("GET /api/v2/projects org scoping", () => {
  it("includes orgId on each project", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; orgId: number | null }> }
    const p1 = body.projects.find((p) => p.id === "p1")
    expect(p1?.orgId).toBe(1)
  })

  it("filters by ?orgId", async () => {
    await seedTwoOrgProjects()
    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string }> }
    const ids = body.projects.map((p) => p.id).sort()
    expect(ids).toEqual(["p1", "p2"])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/projects-org-scope.test.ts`
Expected: FAIL — `orgId` is `undefined` on projects; `?orgId=1` returns all 3.

- [ ] **Step 3: Add `org_id` to the SELECT and an optional filter**

In `auth-worker/src/routes/projects.ts`, in the `projects.get("/", …)` handler:

(a) Read the filter at the top of the handler (after `const user = c.get("user")`):

```ts
  const orgIdParam = c.req.query("orgId")
  const orgFilter = orgIdParam != null && orgIdParam !== "" ? Number(orgIdParam) : null
```

(b) Add `p.org_id` to the SELECT column list (first line of the query, alongside `p.id, p.name`):

```sql
    `SELECT p.id, p.name, p.org_id,
```

(c) Add the filter to the `WHERE` clause — change the closing of the `WHERE (...)` group to also constrain org when requested. Replace:

```sql
      WHERE p.archived_at IS NULL
        AND (
          p.created_by = ?
          OR pm.user_id = ?
          OR gg.max_grant IS NOT NULL
          OR (p.org_id IS NOT NULL AND om.user_id = ?)
        )
```

with:

```sql
      WHERE p.archived_at IS NULL
        AND (?10 IS NULL OR p.org_id = ?10)
        AND (
          p.created_by = ?
          OR pm.user_id = ?
          OR gg.max_grant IS NOT NULL
          OR (p.org_id IS NOT NULL AND om.user_id = ?)
        )
```

(d) Append `orgFilter` as the 11th bind argument (the query uses positional `?` for the first ten; `?10` references the new param). Update the `.bind(...)` call to add `orgFilter` as the final argument:

```ts
    .bind(
      user.id, user.id, user.id, user.id,
      user.id, user.id, user.id,
      user.id, user.id, user.id,
      orgFilter, // ?10
    )
```

(e) Add `orgId` to the row type and the response map:

```ts
    .all<{
      id: string
      name: string
      org_id: number | null
      role_level: number
      role_source: "creator" | "override" | "org" | "group"
    }>()
```

```ts
    projects: (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      orgId: row.org_id,
      role: { level: row.role_level, name: roleNameFor(row.role_level), source: row.role_source },
      files: filesByProject.get(row.id) ?? [],
    })),
```

> Note on D1 positional params: D1 supports numbered `?N`. If mixing `?` and `?N` is rejected at runtime, convert the whole query to numbered params (`?1`…`?11`) — the harness smoke test in Step 4 will surface this immediately.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/projects-org-scope.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add auth-worker/src/routes/projects.ts auth-worker/src/__tests__/projects-org-scope.test.ts
git commit -m "feat(auth-worker): orgId on projects list + ?orgId filter"
```

---

### Task 4: Gate `POST /api/v2/projects` on org role ≥ maintainer

**Files:**
- Modify: `auth-worker/src/routes/projects.ts:148-184` (the create handler)
- Test: `auth-worker/src/__tests__/projects-org-scope.test.ts` (add a `describe`)

- [ ] **Step 1: Write the failing test**

Append to `auth-worker/src/__tests__/projects-org-scope.test.ts`:

```ts
describe("POST /api/v2/projects org gating", () => {
  async function seedOrg() {
    await seedUser(1, "wendi") // org owner
    await seedUser(2, "anna")  // org maintainer
    await seedUser(3, "tom")   // org contributor
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)").run()
  }

  async function create(username: string, body: Record<string, unknown>) {
    return app.request("/api/v2/projects", { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) }, env)
  }

  it("lets an org maintainer create into the org", async () => {
    await seedOrg()
    const res = await create("anna", { id: "p-new", name: "New", orgId: 1 })
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_DB.prepare("SELECT org_id FROM projects WHERE id = 'p-new'").first<{ org_id: number }>()
    expect(row?.org_id).toBe(1)
  })

  it("rejects an org contributor (403)", async () => {
    await seedOrg()
    const res = await create("tom", { id: "p-x", name: "X", orgId: 1 })
    expect(res.status).toBe(403)
  })

  it("falls back to the personal org when orgId omitted", async () => {
    await seedUser(5, "solo")
    const res = await create("solo", { id: "p-solo", name: "Solo" })
    expect(res.status).toBe(200)
    // getOrCreateUserOrg created solo's personal org; the project points at it.
    const proj = await env.AQUILLA_DB.prepare("SELECT org_id FROM projects WHERE id = 'p-solo'").first<{ org_id: number }>()
    const org = await env.AQUILLA_DB.prepare("SELECT id FROM organizations WHERE owner_user_id = 5").first<{ id: number }>()
    expect(proj?.org_id).toBe(org?.id)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/projects-org-scope.test.ts`
Expected: FAIL — the contributor case returns 200 (no gate yet); the maintainer case may write the wrong `org_id` (currently always the creator's personal org).

- [ ] **Step 3: Accept `orgId` + gate on org role**

In `auth-worker/src/routes/projects.ts`: ensure the create body schema allows an optional `orgId`. Find the `zValidator("json", …)` schema for the create route and add `orgId: z.number().int().optional()` to it. Then import `getOrgMemberRole` and `ROLE` (from `../services/org-permissions` and `../types` respectively — add to existing imports), and replace the org-resolution block (currently lines ~152-161):

```ts
    let orgId: number | null = null
    try {
      orgId = (await getOrCreateUserOrg(c.env, user)).id
    } catch (err) {
      console.warn("personal org setup failed; creating project without org:", err)
    }
```

with:

```ts
    let orgId: number | null = null
    if (body.orgId != null) {
      // Creating into a specific org is an org-level function: require the
      // caller's org role ≥ maintainer (see spec Risk 3).
      const orgRole = await getOrgMemberRole(c.env, body.orgId, user.id)
      if (orgRole == null || orgRole < ROLE.MAINTAINER) {
        return c.json({ error: "org role ≥ maintainer required to create a project here" }, 403)
      }
      orgId = body.orgId
    } else {
      try {
        orgId = (await getOrCreateUserOrg(c.env, user)).id
      } catch (err) {
        console.warn("personal org setup failed; creating project without org:", err)
      }
    }
```

(`body` already exists from `c.req.valid("json")`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/projects-org-scope.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add auth-worker/src/routes/projects.ts auth-worker/src/__tests__/projects-org-scope.test.ts
git commit -m "feat(auth-worker): gate project creation on org role >= maintainer"
```

---

### Task 5: Read-only group ("Teams") endpoints

**Files:**
- Modify: `auth-worker/src/services/org-permissions.ts`
- Modify: `auth-worker/src/routes/orgs.ts`
- Test: `auth-worker/src/__tests__/groups-read.test.ts`

- [ ] **Step 1: Write the failing test**

Create `auth-worker/src/__tests__/groups-read.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function seedGroups() {
  await seedUser(1, "wendi") // owner + group member
  await seedUser(2, "anna")  // group member
  await seedUser(9, "outsider") // not an org member
  await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name) VALUES (10, 1, 'West Africa')").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id) VALUES (10, 1), (10, 2)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Bambara', 1, 1)").run()
  await env.AQUILLA_DB.prepare("INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (10, 'pa', 400)").run()
}

describe("GET /api/v2/orgs/:orgId/groups", () => {
  it("lists groups with counts + viewerIsMember", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("anna")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: Array<{ id: number; name: string; memberCount: number; projectCount: number; viewerIsMember: boolean }> }
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]).toMatchObject({ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true })
  })

  it("403s for a non-org-member", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(res.status).toBe(403)
  })
})

describe("GET /api/v2/orgs/:orgId/groups/:groupId", () => {
  it("returns members + attached projects", async () => {
    await seedGroups()
    const res = await app.request("/api/v2/orgs/1/groups/10", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; members: Array<{ username: string }>; projects: Array<{ id: string; name: string; grantedRoleLevel: number }> }
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "wendi"])
    expect(body.projects).toEqual([{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/groups-read.test.ts`
Expected: FAIL — both group routes 404.

- [ ] **Step 3: Add the service helpers**

In `auth-worker/src/services/org-permissions.ts`, add:

```ts
export interface OrgGroupSummary {
  id: number
  name: string
  memberCount: number
  projectCount: number
  viewerIsMember: boolean
}

/** Groups in an org, with counts and whether the viewer is a member. */
export async function listOrgGroups(
  env: Env,
  orgId: number,
  viewerId: number,
): Promise<OrgGroupSummary[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT g.id AS id, g.name AS name,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM group_project_grants gpg WHERE gpg.group_id = g.id) AS project_count,
            EXISTS (SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) AS viewer_is_member
       FROM groups g
      WHERE g.org_id = ?
      ORDER BY g.name COLLATE NOCASE`,
  )
    .bind(viewerId, orgId)
    .all<{ id: number; name: string; member_count: number; project_count: number; viewer_is_member: number }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: r.member_count,
    projectCount: r.project_count,
    viewerIsMember: r.viewer_is_member === 1,
  }))
}

export interface OrgGroupDetail {
  id: number
  name: string
  members: Array<{ userId: number; username: string; roleLevel: number | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }>
}

/** Members + attached projects of a single group. Null if not in this org. */
export async function getOrgGroupDetail(
  env: Env,
  orgId: number,
  groupId: number,
): Promise<OrgGroupDetail | null> {
  const group = await env.AQUILLA_DB.prepare(
    "SELECT id, name FROM groups WHERE id = ? AND org_id = ?",
  )
    .bind(groupId, orgId)
    .first<{ id: number; name: string }>()
  if (!group) return null

  const members = await env.AQUILLA_DB.prepare(
    `SELECT gm.user_id AS user_id, u.username AS username, om.role_level AS role_level
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN org_members om ON om.org_id = ? AND om.user_id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY u.username COLLATE NOCASE`,
  )
    .bind(orgId, groupId)
    .all<{ user_id: number; username: string; role_level: number | null }>()

  const projects = await env.AQUILLA_DB.prepare(
    `SELECT gpg.project_id AS id, p.name AS name, gpg.role_level AS granted
       FROM group_project_grants gpg
       JOIN projects p ON p.id = gpg.project_id
      WHERE gpg.group_id = ?
      ORDER BY p.name COLLATE NOCASE`,
  )
    .bind(groupId)
    .all<{ id: string; name: string; granted: number }>()

  return {
    id: group.id,
    name: group.name,
    members: (members.results ?? []).map((m) => ({ userId: m.user_id, username: m.username, roleLevel: m.role_level })),
    projects: (projects.results ?? []).map((p) => ({ id: p.id, name: p.name, grantedRoleLevel: p.granted })),
  }
}
```

- [ ] **Step 4: Add the routes**

In `auth-worker/src/routes/orgs.ts`, add `listOrgGroups, getOrgGroupDetail` to the `from "../services/org-permissions"` import, then add (after the existing `GET /:orgId/members` route):

```ts
/** GET /api/v2/orgs/:orgId/groups — read-only team list (org members). */
orgs.get("/:orgId/groups", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const groups = await listOrgGroups(c.env, orgId, user.id)
  return c.json({ groups })
})

/** GET /api/v2/orgs/:orgId/groups/:groupId — read-only team detail. */
orgs.get("/:orgId/groups/:groupId", async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  const groupId = parseInt(c.req.param("groupId"), 10)
  if (!Number.isFinite(orgId) || !Number.isFinite(groupId)) return c.json({ error: "invalid id" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "not an org member" }, 403)
  const detail = await getOrgGroupDetail(c.env, orgId, groupId)
  if (!detail) return c.json({ error: "group not found" }, 404)
  return c.json(detail)
})
```

> Route-order note: register `/:orgId/groups` and `/:orgId/groups/:groupId` so they don't collide with `/:orgId/members`. Hono matches by specificity; distinct static segments (`groups` vs `members`) are unambiguous.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/groups-read.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Run the full worker suite**

Run: `cd auth-worker && npx vitest run`
Expected: PASS (everything).

- [ ] **Step 7: Commit**

```bash
git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/groups-read.test.ts
git commit -m "feat(auth-worker): read-only org groups (Teams) endpoints"
```

---

## Self-Review

- **Spec coverage:** `GET /api/v2/orgs` (Task 2) ✓; `org_id` + `?orgId` on projects list (Task 3) ✓; create-into-active-org gated ≥ maintainer (Task 4) ✓; read-only group endpoints (Task 5) ✓. Test-harness change (Task 1) enables all of the above against real SQL. The projects-list `?orgId` behavior — flagged in the spec as hard to test under the old fake — is now covered by a real-D1 route test (Task 3 Step 1).
- **Type consistency:** `listUserOrgs`/`UserOrgSummary`, `listOrgGroups`/`OrgGroupSummary`, `getOrgGroupDetail`/`OrgGroupDetail` are defined in Task 2/5 and consumed by the same-task routes. Response field names (`orgId`, `memberCount`, `projectCount`, `viewerIsMember`, `grantedRoleLevel`) match the spec's response shapes.
- **Placeholder scan:** none — every step carries runnable code/commands. The one runtime risk (mixed `?`/`?N` D1 params in Task 3) is called out with a concrete fallback that the Step 4 test will catch.

## Execution Handoff

Client plan (the org-context shell that consumes these endpoints) is the next document and depends on this one landing first.
