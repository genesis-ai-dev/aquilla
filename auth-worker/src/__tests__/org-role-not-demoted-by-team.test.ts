/**
 * AQU-1274 — a team attachment must not silently demote a higher org role.
 *
 * Reported live by the Biblica ETT Pattani Malay team: Naladda holds org role
 * **Project Lead (500)** on Biblica ETT and reaches the Pattani Malay Bible
 * project through the team `biblica/pattani-malay`, which is attached at the
 * **Contributor (400)** default. She resolved to Contributor, so the Team /
 * Assignments panel ("Project leads & up can see this") was hidden from her.
 *
 * The cause was not "most specific wins" — this resolver has always been
 * AD-12 max-wins. It was AQU-435's `ORG_WIDE_ACCESS_FLOOR`, which silenced the
 * org path *entirely* below Maintainer. That floor answers "may an org grant
 * OPEN a project?" (correctly Maintainer+), but it was also answering "may an
 * org grant raise the LEVEL on a project I already reach?" — and dropping a
 * higher path is precisely the demotion AD-12 forbids.
 *
 * These tests pin both halves of the corrected rule (db/shared/project-roles.ts
 * :: orgPathContribution):
 *   - AQU-435 intact: a sub-maintainer org role still opens nothing on its own.
 *   - AQU-1274 fixed: it no longer lets a team attachment demote.
 *   - An explicit direct `project_members` row still restricts on purpose.
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

describe("AQU-1274 — a team attachment does not demote a higher org role", () => {
  it("the repro: org Project Lead + team Contributor resolves to project_lead, not contributor", async () => {
    await seed()
    await attachTeam(400) // the Contributor default nobody chose on purpose

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; name: string; source: string } }
    // Was 400/"contributor" before the fix — which hid the Assignments panel.
    expect(body.role).toMatchObject({ level: 500, name: "project_lead", source: "org" })
  })

  it("a team attached ABOVE the org role still wins — max-wins is unchanged", async () => {
    await seed()
    await attachTeam(600)

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 600, source: "group" })
  })

  it("AQU-435 intact: a sub-maintainer org role with NO other path still opens nothing", async () => {
    await seed()
    // No team attachment, no direct grant, not the creator.
    const res = await resolveFor("naladda")
    expect(res.status).toBe(403)
  })

  it("an explicit direct project grant still restricts below the org role", async () => {
    await seed()
    // An Owner deliberately pins her to Reviewer on this one project. No team
    // attachment, so the direct grant is her only other path.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES ('pattani', 2, 300, 1)`,
    ).run()

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    // The org role (500) is suppressed: a per-person, per-project grant is a
    // deliberate decision, unlike the team's Contributor default.
    expect(body.role).toMatchObject({ level: 300, source: "override" })
  })

  it("a direct grant suppresses the org path but does not beat a higher team grant", async () => {
    await seed()
    await attachTeam(400)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES ('pattani', 2, 300, 1)`,
    ).run()

    const res = await resolveFor("naladda")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    // Plain AD-12 max-wins between the two explicit paths — unchanged by this
    // fix. The point is only that the org role (500) does NOT enter here, so
    // the direct grant keeps its restricting effect against the org level.
    expect(body.role).toMatchObject({ level: 400, source: "group" })
  })

  it("the project LIST agrees with the single-project resolver", async () => {
    await seed()
    await attachTeam(400)

    // GET /projects is where the SPA's `project.syncRole` comes from, and
    // syncRole is what gates the Assignments panel. A list that still said
    // 400 would leave the panel hidden however the resolver answers.
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
    expect(pattani?.role).toMatchObject({ level: 500, source: "org" })
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
    // The panel used to show "resolved: Contributor" beside "org role: Project
    // Lead" with no explanation — the bug the reporter screenshotted.
    expect(pattani).toMatchObject({ org: 500, resolved: 500 })
  })
})
