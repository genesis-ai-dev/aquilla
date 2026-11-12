/**
 * AQU-1352 review finding: GET /projects/:id/members?minRole=600 skips the
 * roster-floor check (the assignee picker needs Maintainer+ names) but the
 * per-row origins carried real org/team names. A caller below the org roster
 * floor must not learn team structure they cannot see on People & access
 * (spec §3.9 rule 4) — rows stay, names go.
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const sql = (q: string) => env.AQUILLA_PG.prepare(q).run()

async function seed() {
  await seedUser(1, "wendi") // org owner
  await seedUser(2, "anna") // org maintainer
  await seedUser(3, "tom") // org contributor, below the default floor (600)
  await seedUser(5, "lead") // direct 700 + team grant 600
  await sql("INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (1, 'Secret Org Name', 1, 'team')")
  await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)")
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'John', 1, 1)")
  await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1), ('proj1', 5, 700, 1)")
  await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (7, 1, 'Hidden Team Name', 1)")
  await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (7, 5, 1, 100)")
  await sql("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (7, 'proj1', 600, 1)")
}

const members = async (username: string) =>
  app.request("/api/v2/projects/proj1/members?minRole=600", { headers: authHeader(await jwtFor(username)) }, env)

describe("AQU-1352 roster origins are redacted below the org roster floor", () => {
  it("a contributor on the ?minRole=600 path sees rows but no org/team names", async () => {
    await seed()
    const res = await members("tom")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain("Secret Org Name")
    expect(text).not.toContain("Hidden Team Name")
    const body = JSON.parse(text) as { members: Array<{ userId: number; afterDirectRemoval?: unknown }> }
    const lead = body.members.find((m) => Number(m.userId) === 5)
    expect(lead).toBeDefined()
    expect(lead && "afterDirectRemoval" in lead).toBe(false)
  })

  it("an org maintainer still sees the team origin (control: redaction is viewer-scoped)", async () => {
    await seed()
    const text = await (await members("anna")).text()
    expect(text).toContain("Hidden Team Name")
  })
})
