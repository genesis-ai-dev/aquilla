/**
 * AQU-2352 (AQU-2351 D-j) — an org role below Maintainer never raises a team
 * path. (History: AQU-1274 added that "lift" after the Biblica ETT Pattani
 * Malay report — an org Project Lead on a team attached at Contributor
 * resolved to Contributor and lost the Assignments panel. AQU-2352 removed
 * it: org roles are Member, Maintainer and Owner, and migration 0210 gave
 * everyone the lift raised a direct grant at the level they had, which is
 * the last case below.)
 *
 * These tests pin:
 *   - AQU-435: a sub-maintainer org role opens nothing on its own.
 *   - AQU-2352: it raises nothing either — the team's role is the role — and
 *     the single-project resolver, the project list and the members
 *     drill-down all say so.
 *   - The 0210 shape (a direct project row at the old level) resolves to it.
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/**
 * org 1 "Biblica ETT", owned by user 1.
 * user 2 "naladda" — org role Project Lead (500).
 * project 'pattani' — org-owned, created by the owner (so user 2 has no
 * creator path).
 * team 1 "biblica/pattani-malay" — user 2 is a member; not yet attached.
 */
async function seed() {
  await seedUser(1, "org_owner")
  await seedUser(2, "naladda")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Biblica ETT', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 2, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by)
     VALUES ('pattani', 'Pattani Malay Bible', 1, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'biblica/pattani-malay', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (1, 2, 1)",
  ).run()
}

/** Attach the team to the project at `level`. */
async function attachTeam(level: number) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by)
     VALUES (1, 'pattani', ?, 1)`,
  ).bind(level).run()
}

async function resolveFor(username: string) {
  const res = await app.request(
    "/api/v2/projects/pattani",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  return res
}

describe("AQU-2352 — an org role below Maintainer raises no team path", () => {
  it("org Project Lead + team Contributor resolves to the team's Contributor", async () => {
    await seed()
    await attachTeam(400)

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; name: string; source: string } }
    expect(body.role).toMatchObject({ level: 400, name: "contributor", source: "group" })
  })

  it("a team attached above the org role wins — max-wins is unchanged", async () => {
    await seed()
    await attachTeam(600)

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 600, source: "group" })
  })

  it("AQU-435 intact: a sub-maintainer org role with NO other path opens nothing", async () => {
    await seed()
    const res = await resolveFor("naladda")
    expect(res.status).toBe(403)
  })

  it("migration 0210's direct grant at the old level keeps Project Lead", async () => {
    await seed()
    await attachTeam(400)
    await env.AQUILLA_PG.prepare("UPDATE org_members SET role_level = 100 WHERE user_id = 2").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('pattani', 2, 500)`,
    ).run()

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 500, source: "override" })
  })

  it("the project LIST agrees with the single-project resolver", async () => {
    await seed()
    await attachTeam(400)

    // GET /projects is where the SPA's `project.syncRole` comes from.
    const res = await app.request(
      "/api/v2/projects?orgId=1",
      { headers: authHeader(await jwtFor("naladda")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: { id: string; role: { level: number; source: string } }[]
    }
    const pattani = body.projects.find((p) => p.id === "pattani")
    expect(pattani?.role).toMatchObject({ level: 400, source: "group" })
  })

  it("the members drill-down reports the same resolved role that enforcement uses", async () => {
    await seed()
    await attachTeam(400)

    const res = await app.request(
      "/api/v2/orgs/1/members/2/access",
      { headers: authHeader(await jwtFor("org_owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgRole: number
      projects: { projectId: string; org: number | null; resolved: number }[]
    }
    expect(body.orgRole).toBe(500)
    const pattani = body.projects.find((p) => p.projectId === "pattani")
    expect(pattani).toMatchObject({ org: null, resolved: 400 })
  })
})
