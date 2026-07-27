/**
 * Asserts that GET /api/v2/projects/:projectId/members emits secondarySources
 * for members who reach the project via more than one path (AD-12 max-wins).
 *
 * Example: anna has an org-wide maintainer (600) + direct reviewer (300) on
 * project "pa". max-wins → winning source = org (level 600).
 * secondarySources should list [{ source: "override", level: 300, ... }].
 * (AQU-435: the org path only exists at maintainer+ — a sub-maintainer org
 * role would contribute nothing and appear in no list.)
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "wendi") // org owner / caller
  await seedUser(2, "anna")  // subject with multi-path access

  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)"
  ).run()

  // wendi = org owner (700), anna = org maintainer (600 — the AQU-435 floor,
  // so her org role still counts as a grant path)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)"
  ).run()

  // project pa: created by wendi, belongs to org 1
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)"
  ).run()

  // anna also has a direct reviewer (300) override on pa → loses to org (600)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 300, 1)"
  ).run()
}

describe("GET /api/v2/projects/:projectId/members — secondarySources", () => {
  it("emits secondarySources listing non-winning contributing paths", async () => {
    await seed()

    const res = await app.request(
      "/api/v2/projects/pa/members",
      { headers: authHeader(await jwtFor("wendi")) },
      env
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      members: Array<{
        userId: number
        username: string
        role: { level: number; name: string; source: string }
        secondarySources: Array<{ source: string; level: number; name: string }>
      }>
    }

    const anna = body.members.find((m) => m.username === "anna")
    expect(anna).toBeDefined()

    // Winning path is the org-wide maintainer grant (level 600 > direct 300)
    expect(anna!.role.source).toBe("org")
    expect(anna!.role.level).toBe(600)

    // secondarySources should list the non-winning direct override
    expect(anna!.secondarySources).toHaveLength(1)
    expect(anna!.secondarySources[0]).toMatchObject({
      source: "override",
      level: 300,
    })
  })

  it("emits empty secondarySources for a member with only one contributing path", async () => {
    // Add a third user who has ONLY a direct grant (no org membership on this project)
    await seed()
    await seedUser(3, "bob")
    // bob gets a direct contributor grant but is NOT in the org
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 3, 200, 1)"
    ).run()

    const res = await app.request(
      "/api/v2/projects/pa/members",
      { headers: authHeader(await jwtFor("wendi")) },
      env
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      members: Array<{
        userId: number
        username: string
        secondarySources: Array<unknown>
      }>
    }

    // bob has only a direct override path → secondarySources should be empty
    const bob = body.members.find((m) => m.username === "bob")
    expect(bob).toBeDefined()
    expect(bob!.secondarySources).toEqual([])
  })
})
