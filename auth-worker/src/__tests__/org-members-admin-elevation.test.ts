// [Pen test] Authorization & access control (2026-09-22).
//
// getEffectiveOrgRole folds the ADMIN_EMAILS allowlist in as an unconditional
// owner (700) on EVERY org — correct for reads (support/oversight, see
// platform-admin-access.test.ts) but POST/DELETE /:orgId/members WRITE
// governance: before this fix, a platform admin with a plain session cookie
// (no step-up) could grant real, persistent OWNER membership in an org they
// had never joined to an arbitrary account, or strip a foreign org's real
// owners — a durable, unaudited backdoor. The external Agent-API surface
// already excludes platform-admin from org-membership writes for exactly
// this reason (org-members-engine.ts: "confers no cross-tenant governance
// authority"); this test pins the same exclusion on the browser-session path.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedForeignOrg() {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
}

const addMember = (jwt: string, orgId: number, username: string, role: number) =>
  app.request(
    `/api/v2/orgs/${orgId}/members`,
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ username, role }) },
    env,
  )

const removeMember = (jwt: string, orgId: number, userId: number) =>
  app.request(`/api/v2/orgs/${orgId}/members/${userId}`, { method: "DELETE", headers: authHeader(jwt) }, env)

const requestCode = (jwt: string) =>
  app.request("/api/v2/admin/elevation/request", { method: "POST", headers: authHeader(jwt) }, env)
const verifyCode = (jwt: string, code: string) =>
  app.request(
    "/api/v2/admin/elevation/verify",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ code }) },
    env,
  )

describe("org membership writes via the platform-admin fallback", () => {
  afterEach(() => {
    env.ADMIN_REQUIRE_ELEVATION = undefined
  })

  it("blocks an un-elevated platform admin from granting OWNER on a foreign org", async () => {
    env.ADMIN_REQUIRE_ELEVATION = "true"
    await seedForeignOrg()
    await seedUser(7, "root") // root@example.com — the test ADMIN_EMAILS allowlist
    await seedUser(9, "mallory-ally") // the account the admin tries to plant as owner

    const res = await addMember(await jwtFor("root"), 1, "mallory-ally", 700)
    expect(res.status).toBe(403)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM org_members WHERE org_id = 1 AND user_id = 9",
    ).first()
    expect(row).toBeNull()
  })

  it("allows the write once the platform admin has stepped up", async () => {
    env.ADMIN_REQUIRE_ELEVATION = "true"
    await seedForeignOrg()
    await seedUser(7, "root")
    await seedUser(9, "newowner")
    const jwt = await jwtFor("root")

    const { devCode } = (await (await requestCode(jwt)).json()) as { devCode?: string }
    expect((await verifyCode(jwt, devCode as string)).status).toBe(200)

    const res = await addMember(jwt, 1, "newowner", 700)
    expect(res.status).toBe(200)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = 9",
    ).first<{ role_level: number }>()
    expect(row?.role_level).toBe(700)
  })

  it("blocks an un-elevated platform admin from removing a foreign org's real owner", async () => {
    env.ADMIN_REQUIRE_ELEVATION = "true"
    await seedForeignOrg()
    await seedUser(7, "root")

    const res = await removeMember(await jwtFor("root"), 1, 1)
    expect(res.status).toBe(403)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM org_members WHERE org_id = 1 AND user_id = 1",
    ).first()
    expect(row).not.toBeNull()
  })

  it("never requires elevation for a genuine org owner acting on their own org", async () => {
    env.ADMIN_REQUIRE_ELEVATION = "true"
    await seedUser(2, "genuineowner")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (5, 'Real Org', 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (5, 2, 700, 2)",
    ).run()
    await seedUser(3, "recruit")

    const res = await addMember(await jwtFor("genuineowner"), 5, "recruit", 400)
    expect(res.status).toBe(200)
  })

  it("still denies a non-admin, non-owner outright regardless of elevation state", async () => {
    env.ADMIN_REQUIRE_ELEVATION = "true"
    await seedForeignOrg()
    await seedUser(8, "outsider")
    await seedUser(9, "target")

    const res = await addMember(await jwtFor("outsider"), 1, "target", 700)
    expect(res.status).toBe(403)
  })
})
