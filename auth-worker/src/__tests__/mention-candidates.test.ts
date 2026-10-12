// AQU-1815: the comment @mention picker's candidate list must be readable by
// every project member, whatever the org's roster floor says.
//
// GET /api/v2/projects/:id/members gates on the effective roster floor
// (AQU-485 rosterViewMinRole, lowered to the assignment floor by AQU-1308 —
// Project Lead under the shipped defaults). The picker was fed by that read,
// so a Contributor saw "No one on this project to mention" while sharing a
// lane with half the team, and a mention is only stored when a suggestion is
// picked. GET …/mention-candidates answers the picker instead:
//
//   1. A caller the org lets read the roster gets the roster (unchanged
//      experience for Project Lead and above).
//   2. Below the floor the caller gets their lane-mates — members holding a
//      lane grant on any lane the caller holds one on — plus Maintainer and
//      above, the "view admins" set the roster's ?minRole= bypass already
//      discloses. `restricted: true` says so.
//   3. Below-Maintainer members outside the caller's lanes are NOT named,
//      and no email ever is: AQU-485's safe-by-default promise holds.
//   4. The roster read itself still 403s for the same caller — this route
//      does not loosen it.
//   5. A project with no org has no floor; everyone gets the roster.
//   6. Non-members get 403.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const LANE_FR = "lanefr01"
const LANE_DE = "lanede01"

async function seedOrgAndProject() {
  await seedUser(1, "olive") // org owner (700)
  await seedUser(2, "mia")   // org maintainer (600), no lane rows
  await seedUser(3, "lena")  // project lead (500), unscoped → fanned out to both lanes
  await seedUser(4, "cody")  // contributor (400) on the French lane
  await seedUser(5, "dana")  // contributor (400) on the German lane only
  await seedUser(6, "finn")  // reviewer (300) on the French lane
  await seedUser(7, "zed")   // not on the project at all

  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Partner Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 400, 1),
      (1, 4, 400, 1),
      (1, 5, 400, 1),
      (1, 6, 300, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Pattani Malay Bible', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
      ('proj1', 3, 500, 1),
      ('proj1', 4, 400, 1),
      ('proj1', 5, 400, 1),
      ('proj1', 6, 300, 1)`,
  ).run()
  // Lane rows reference `lanes` (project_id, id); a source lane is not
  // lane-addressable, so only the two target lanes carry grants.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position) VALUES
      ('lanesrc1', 'proj1', 'source', 'English', NULL, NULL, 0),
      ('${LANE_FR}', 'proj1', 'target', 'French', NULL, 'fr', 1),
      ('${LANE_DE}', 'proj1', 'target', 'German', NULL, 'de', 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by) VALUES
      ('proj1', 3, '${LANE_FR}', 500, 1),
      ('proj1', 3, '${LANE_DE}', 500, 1),
      ('proj1', 4, '${LANE_FR}', 400, 1),
      ('proj1', 5, '${LANE_DE}', 400, 1),
      ('proj1', 6, '${LANE_FR}', 300, 1)`,
  ).run()
}

async function seedPersonalProject() {
  await seedUser(1, "olive")
  await seedUser(4, "cody")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('solo1', 'Olive Notes', NULL, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('solo1', 4, 400, 1)",
  ).run()
}

interface CandidatesBody {
  candidates?: Array<{ userId: number; username: string; email?: unknown }>
  restricted?: boolean
}

const getCandidates = async (username: string, projectId = "proj1") =>
  app.request(
    `/api/v2/projects/${projectId}/mention-candidates`,
    { headers: authHeader(await jwtFor(username)) },
    env,
  )

const getRoster = async (username: string) =>
  app.request("/api/v2/projects/proj1/members", { headers: authHeader(await jwtFor(username)) }, env)

const usernames = (body: CandidatesBody) => (body.candidates ?? []).map((c) => c.username).sort()

describe("AQU-1815 — GET /projects/:id/mention-candidates", () => {
  it("a contributor below the roster floor gets lane-mates plus Maintainer and above", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("cody")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CandidatesBody
    // French lane: lena (fan-out), finn, cody himself. Admins: olive, mia.
    // dana is on the German lane only and stays unnamed.
    expect(usernames(body)).toEqual(["cody", "finn", "lena", "mia", "olive"])
    expect(body.restricted).toBe(true)
  })

  it("names nobody below Maintainer outside the caller's lanes, and no email", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("dana")
    const body = (await res.json()) as CandidatesBody
    expect(usernames(body)).toEqual(["dana", "lena", "mia", "olive"])
    expect(usernames(body)).not.toContain("cody")
    expect(usernames(body)).not.toContain("finn")
    for (const candidate of body.candidates ?? []) {
      expect(candidate).not.toHaveProperty("email")
      expect(typeof candidate.userId).toBe("number")
    }
  })

  it("a reviewer (300) is served the same lane-scoped list", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("finn")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CandidatesBody
    expect(usernames(body)).toEqual(["cody", "finn", "lena", "mia", "olive"])
    expect(body.restricted).toBe(true)
  })

  it("a below-floor member with no lane grant still gets Maintainer and above", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "DELETE FROM project_member_lane_roles WHERE project_id = 'proj1' AND user_id = 4",
    ).run()
    const res = await getCandidates("cody")
    const body = (await res.json()) as CandidatesBody
    expect(usernames(body)).toEqual(["mia", "olive"])
    expect(body.restricted).toBe(true)
  })

  it("a project lead at the effective floor gets the whole roster, unrestricted", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("lena")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CandidatesBody
    expect(usernames(body)).toEqual(["cody", "dana", "finn", "lena", "mia", "olive"])
    expect(body.restricted).toBe(false)
  })

  it("does not loosen the roster read for the same caller", async () => {
    await seedOrgAndProject()
    const res = await getRoster("cody")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { rosterHidden?: boolean }).rosterHidden).toBe(true)
  })

  it("a project with no org has no floor: everyone gets the roster", async () => {
    await seedPersonalProject()
    const res = await getCandidates("cody", "solo1")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CandidatesBody
    expect(usernames(body)).toEqual(["cody", "olive"])
    expect(body.restricted).toBe(false)
  })

  it("a non-member gets 403 and learns nothing", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("zed")
    expect(res.status).toBe(403)
    const body = (await res.json()) as CandidatesBody
    expect(body.candidates).toBeUndefined()
  })

  it("an unknown project is 404", async () => {
    await seedOrgAndProject()
    const res = await getCandidates("olive", "nope")
    expect([403, 404]).toContain(res.status)
  })
})
