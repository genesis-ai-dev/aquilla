/**
 * AQU-1352 P0 (spec 3.5 / 3.9 rule 5) — GET /api/v2/me/create-targets.
 *
 * Tim is org Guest + team Owner: POST /projects into the org 403s (org role
 * < maintainer), and the create dialog had no way to offer anywhere else.
 * This endpoint is the picker's source of truth, so it must list exactly the
 * orgs POST /projects would accept, plus Personal (always valid — POST with
 * no orgId lazy-creates it).
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

interface Target {
  kind: "org" | "personal"
  orgId: number | null
  name: string
  path: string[]
  role: number
}

async function seedOrg() {
  await seedUser(1, "owner")
  await seedUser(2, "maint")
  await seedUser(3, "tim")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (10, 'Biblica ETT', 1, 'team')",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (10, 1, 700, 1), (10, 2, 600, 1), (10, 3, 400, 1)`,
  ).run()
}

async function targetsFor(username: string): Promise<Target[]> {
  const res = await app.request(
    "/api/v2/me/create-targets",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Target[]
}

describe("AQU-1352 GET /api/v2/me/create-targets", () => {
  it("a maintainer sees the org (POST /projects would accept it)", async () => {
    await seedOrg()
    const targets = await targetsFor("maint")
    expect(targets.find((t) => t.orgId === 10)).toMatchObject({
      kind: "org",
      name: "Biblica ETT",
      path: ["Biblica ETT"],
      role: 600,
    })
  })

  it("a contributor does not see the org (POST would 403) but still gets Personal", async () => {
    await seedOrg()
    const targets = await targetsFor("tim")
    expect(targets.some((t) => t.orgId === 10)).toBe(false)
    expect(targets.filter((t) => t.kind === "personal")).toHaveLength(1)
  })

  it("Personal is listed with orgId null and NOT created as a side effect of GET", async () => {
    await seedOrg()
    const targets = await targetsFor("tim")
    expect(targets[0]).toMatchObject({ kind: "personal", orgId: null })
    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM organizations WHERE owner_user_id = 3",
    ).first()
    expect(row).toBeNull()
  })

  it("an existing personal org is returned once, as personal (not duplicated as an org)", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (11, 'maint''s workspace', 2, 'personal')",
    ).run()
    const targets = await targetsFor("maint")
    expect(targets.filter((t) => t.orgId === 11)).toHaveLength(1)
    expect(targets[0]).toMatchObject({ kind: "personal", orgId: 11 })
  })

  it("an owned TEAM org is an org target, not Personal (billing_scope identifies personal)", async () => {
    // Review finding: owner_user_id alone mislabeled user 1's team org 10 as
    // Personal and hid it from the org list, so picking "Personal" created
    // into the team org. User 1 has no personal org yet.
    await seedOrg()
    const targets = await targetsFor("owner")
    expect(targets.find((t) => t.orgId === 10)).toMatchObject({ kind: "org", name: "Biblica ETT", role: 700 })
    expect(targets.filter((t) => t.kind === "personal")).toEqual([
      expect.objectContaining({ kind: "personal", orgId: null }),
    ])
  })

  it("a platform admin sees every org (getEffectiveOrgRole treats them as owner)", async () => {
    await seedOrg()
    await seedUser(7, "root") // root@example.com is on the test ADMIN_EMAILS allowlist
    const targets = await targetsFor("root")
    expect(targets.find((t) => t.orgId === 10)).toMatchObject({ kind: "org", role: 700 })
  })
})
