// AQU-1308: the assignee picker's member list must be readable by anyone the
// org authorizes to assign work.
//
// Root cause the tests below pin down: GET /api/v2/projects/:id/members gates
// on the org's `rosterViewMinRole` (AQU-485, default MAINTAINER 600), while
// work assignment gates on `assignmentMinRole` (AQU-1037, default PROJECT_LEAD
// 500). The two floors are independent and the assignment floor ships BELOW
// the roster floor, so out of the box a project lead was authorized to assign
// work but 403'd (`rosterHidden: true`) on the roster the picker is built from
// — every partner org's Assignee dropdown rendered empty.
//
// The route now applies `getProjectRosterViewMinRole`, the LOWER of the two
// floors. What that must and must not change:
//
//   1. A project lead (500) at the default floors CAN read the project roster.
//   2. Roles BELOW the assignment floor are still gated by rosterViewMinRole
//      exactly as before — AQU-485's safe-by-default promise is untouched.
//   3. Raising `assignmentMinRole` back above the lead re-hides the roster
//      from them: the carve-out follows assignment authority, it is not a
//      blanket exemption for level 500.
//   4. Platform-admin / owner behavior is unchanged.
//   5. The carve-out is project-scoped — it grants no org-wide roster access.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrgAndProject() {
  await seedUser(1, "olive")  // org owner (700)
  await seedUser(2, "mia")    // org maintainer (600)
  await seedUser(3, "lena")   // project lead (500) via a direct project grant
  await seedUser(4, "cody")   // contributor (400) via a direct project grant

  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Partner Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 400, 1),
      (1, 4, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Pattani Malay Bible', 1, 1)",
  ).run()
  // AQU-435: an org-baseline role no longer reaches a project on its own, so
  // give lena and cody explicit project grants — they must hit the roster
  // gate, not the project-access 403.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
      ('proj1', 3, 500, 1),
      ('proj1', 4, 400, 1)`,
  ).run()
}

async function setOrgSettings(settings: Record<string, unknown>) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
  )
    .bind(JSON.stringify(settings))
    .run()
}

const getProjectMembers = async (username: string) =>
  app.request(
    "/api/v2/projects/proj1/members",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )

const getOrgMembers = async (username: string) =>
  app.request("/api/v2/orgs/1/members", { headers: authHeader(await jwtFor(username)) }, env)

describe("AQU-1308 — project-lead access to the assignee picker's roster", () => {
  it("a project lead (500) can read the project roster under the shipped defaults", async () => {
    await seedOrgAndProject()
    const res = await getProjectMembers("lena")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ username: string }> }
    // The picker needs real names, not an empty list.
    expect(body.members.map((m) => m.username).sort()).toEqual(["cody", "lena", "mia", "olive"])
  })

  it("a project lead (500) can read the roster when only rosterViewMinRole is configured high", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getProjectMembers("lena")
    expect(res.status).toBe(200)
  })

  it("a contributor (400) below the assignment floor is still gated by rosterViewMinRole", async () => {
    await seedOrgAndProject()
    const res = await getProjectMembers("cody")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean; members?: unknown }
    expect(body.rosterHidden).toBe(true)
    // The refusal must not leak the roster or its size under any key.
    expect(body.members).toBeUndefined()
  })

  it("raising assignmentMinRole above the lead re-hides the roster from them", async () => {
    await seedOrgAndProject()
    // The carve-out tracks assignment authority: a lead who may no longer
    // assign work has no reason to enumerate the roster.
    await setOrgSettings({ rosterViewMinRole: 600, assignmentMinRole: 600 })
    const res = await getProjectMembers("lena")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean }
    expect(body.rosterHidden).toBe(true)
  })

  it("lowering assignmentMinRole extends the roster to the contributor who may now assign", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600, assignmentMinRole: 400 })
    const res = await getProjectMembers("cody")
    expect(res.status).toBe(200)
  })

  it("an owner-only roster floor is not lowered to the assignment floor for a maintainer", async () => {
    await seedOrgAndProject()
    // assignmentMinRole stays at its default (project lead, 500). The old
    // min() made the effective floor 500, so a maintainer still received the
    // roster and the badge looked like it had snapped back to maintainers.
    await setOrgSettings({ rosterViewMinRole: 700 })
    const maintainer = await getProjectMembers("mia")
    expect(maintainer.status).toBe(403)
    const hidden = (await maintainer.json()) as { rosterHidden?: boolean; members?: unknown }
    expect(hidden.rosterHidden).toBe(true)
    expect(hidden.members).toBeUndefined()

    expect((await getProjectMembers("olive")).status).toBe(200)
  })

  it("maintainer and owner behavior is unchanged", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    expect((await getProjectMembers("mia")).status).toBe(200)
    expect((await getProjectMembers("olive")).status).toBe(200)
  })

  it("the carve-out is project-scoped — a lead gets no org-wide roster access", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    // Assigning work is a project-scoped authority; the org members list keeps
    // the plain rosterViewMinRole gate. lena is an org contributor (400).
    const res = await getOrgMembers("lena")
    expect(res.status).toBe(403)
  })
})
