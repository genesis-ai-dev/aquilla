# Org Create & Rename — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Let users create a new named org and rename an existing one — so an org can be "Come and See" instead of the auto-named "<username>'s workspace".

**Architecture:** Two endpoints on the orgs router — `POST /api/v2/orgs` (create; any auth user becomes owner) and `PATCH /api/v2/orgs/:orgId` (rename; org role ≥ maintainer). Client wrappers + the `OrgSwitcher`'s "Create org — coming soon" row becomes a real create form, plus an admin rename affordance. `listMyOrgs` already handles a user owning multiple orgs, so the switcher lists the new org automatically after `refresh()`.

**Tech Stack:** Hono + D1 (real-D1 harness); React + RTL. **Design source:** committed spec Phase 2 (org create/rename). Deferred: org delete/transfer, billing.

---

### Task R1: Backend — create + rename org

**Files:** modify `auth-worker/src/services/org-permissions.ts`, `auth-worker/src/routes/orgs.ts`; test `auth-worker/src/__tests__/org-create-rename.test.ts`.

- [ ] **Step 1: failing test** — `auth-worker/src/__tests__/org-create-rename.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("POST /api/v2/orgs (create)", () => {
  it("creates a named org with the caller as owner", async () => {
    await seedUser(1, "wendi")
    const res = await app.request("/api/v2/orgs", { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Come and See" }) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; name: string; role: { level: number } }
    expect(body).toMatchObject({ name: "Come and See", role: { level: 700 } })
    const mem = await env.AQUILLA_DB.prepare("SELECT role_level FROM org_members WHERE org_id = ? AND user_id = 1").bind(body.id).first<{ role_level: number }>()
    expect(mem?.role_level).toBe(700)
    const org = await env.AQUILLA_DB.prepare("SELECT owner_user_id FROM organizations WHERE id = ?").bind(body.id).first<{ owner_user_id: number }>()
    expect(org?.owner_user_id).toBe(1)
  })
})

describe("PATCH /api/v2/orgs/:orgId (rename)", () => {
  async function seedOrg() {
    await seedUser(1, "wendi"); await seedUser(2, "tom")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Old Name', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
  }
  it("renames the org for a maintainer+ caller", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", { method: "PATCH", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ name: "Come and See" }) }, env)
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_DB.prepare("SELECT name FROM organizations WHERE id = 1").first<{ name: string }>()
    expect(row?.name).toBe("Come and See")
  })
  it("rejects a sub-maintainer caller with 403", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", { method: "PATCH", headers: authHeader(await jwtFor("tom")), body: JSON.stringify({ name: "Hijack" }) }, env)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: run, verify fail.**

- [ ] **Step 3: services** in `org-permissions.ts`:

```ts
export async function createOrgForUser(env: Env, user: AuthUser, name: string): Promise<{ id: number; name: string }> {
  const inserted = await env.AQUILLA_DB.prepare(
    "INSERT INTO organizations (name, owner_user_id) VALUES (?, ?) RETURNING id",
  ).bind(name, user.id).first<{ id: number }>()
  if (!inserted) throw new Error("failed to insert organization")
  await env.AQUILLA_DB.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?) ON CONFLICT(org_id, user_id) DO NOTHING",
  ).bind(inserted.id, user.id, user.id).run()
  return { id: inserted.id, name }
}

export async function renameOrg(env: Env, orgId: number, name: string): Promise<void> {
  await env.AQUILLA_DB.prepare(
    "UPDATE organizations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(name, orgId).run()
}
```

- [ ] **Step 4: routes** in `orgs.ts` (import `createOrgForUser, renameOrg`; `ROLE` is imported). Add `POST /` near the existing `GET /` (the list route from Phase 1):

```ts
const createOrgBody = z.object({ name: z.string().min(1).max(200) })
orgs.post("/", zValidator("json", createOrgBody), async (c) => {
  const user = c.get("user")
  const { name } = c.req.valid("json")
  const org = await createOrgForUser(c.env, user, name)
  return c.json({ id: org.id, name: org.name, role: { level: 700, name: ROLE_NAMES[700] ?? "owner" } })
})

const renameOrgBody = z.object({ name: z.string().min(1).max(200) })
orgs.patch("/:orgId", zValidator("json", renameOrgBody), async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null || role < ROLE.MAINTAINER) return c.json({ error: "org role >= maintainer required" }, 403)
  const { name } = c.req.valid("json")
  await renameOrg(c.env, orgId, name)
  return c.json({ id: orgId, name })
})
```

Route-order note: `POST /` and `PATCH /:orgId` must not collide with existing `GET /`, `GET /me`, `POST /:orgId/members`, etc. `PATCH /:orgId` is a distinct method+path; fine.

- [ ] **Step 5: run PASS + full worker suite.**
- [ ] **Step 6: commit** — `git add auth-worker/src/services/org-permissions.ts auth-worker/src/routes/orgs.ts auth-worker/src/__tests__/org-create-rename.test.ts && git commit -m "feat(auth-worker): create + rename org endpoints"`

---

### Task R2: Client — create org in switcher + rename (admin)

**Files:** modify `src/lib/frontier/orgs.ts`, `src/components/org/OrgSwitcher.tsx` (+ test).

- [ ] **Step 1:** add to `src/lib/frontier/orgs.ts`:

```ts
export async function createOrg(jwt: string, name: string): Promise<OrgSummary> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ name }) })
  if (!res.ok) throw new Error(`createOrg failed: HTTP ${res.status}`)
  return (await res.json()) as OrgSummary
}
export async function renameOrg(jwt: string, orgId: number, name: string): Promise<void> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name }) })
  if (!res.ok) throw new Error(`renameOrg failed: HTTP ${res.status}`)
}
```

(`authHeaders` is the file-local helper; `OrgSummary`/`fetchWithTimeout`/`FRONTIER_BASE` already exist.)

- [ ] **Step 2:** in `src/components/org/OrgSwitcher.tsx` (it uses `useActiveOrg()` → `{ orgs, activeOrg, setActiveOrg }` — also pull `refresh` + the session `jwt` via `useFrontierSession`):
  - Replace the disabled "Create org — coming soon" row with a **"+ Create org"** button that reveals an inline name input + Create → `const o = await createOrg(jwt, name); await refresh(); setActiveOrg(o.id); setOpen(false)`.
  - Add an admin-only **"Rename"** affordance for the active org (when `activeOrg.role.level >= 600`): an inline input prefilled with the current name + Save → `await renameOrg(jwt, activeOrg.id, name); await refresh()`.
  - Keep `jwt` non-null guards.

- [ ] **Step 3:** test `src/components/org/OrgSwitcher.test.tsx` (extend): mock `createOrg`/`renameOrg` (add to the `@/lib/frontier/orgs` mock); assert clicking "Create org" + submitting a name calls `createOrg` then the org is active; assert the rename affordance shows for an owner and calls `renameOrg`. `npx vitest run src/components/org/OrgSwitcher.test.tsx` + `npx tsc -b` + full suite.
- [ ] **Step 4: commit** — `git add src/lib/frontier/orgs.ts src/components/org/OrgSwitcher.tsx src/components/org/OrgSwitcher.test.tsx && git commit -m "feat(client): create + rename org from the switcher"`

---

## Self-Review
- Coverage: create (owner) + rename (maintainer gate) backend ✓; client create-in-switcher + admin rename ✓; multi-owned-org already handled by `listMyOrgs` ✓.
- Types: `createOrgForUser`/`renameOrg` (server) + `createOrg`/`renameOrg` (client) consumed by their tasks; `OrgSummary` reused.
- Placeholders: none. Route-order + the existing OrgSwitcher menu structure flagged for the implementer to respect.
