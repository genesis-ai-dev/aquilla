import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

describe("org member removal cascades to group_members", () => {
  it("removes the user's team memberships in the org", async () => {
    await seedUser(1, "wendi") // owner
    await seedUser(2, "anna")  // member, on a team
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)").run()

    const res = await app.request("/api/v2/orgs/1/members/2", { method: "DELETE", headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)

    const orgMember = await env.AQUILLA_DB.prepare("SELECT user_id FROM org_members WHERE org_id = 1 AND user_id = 2").first()
    expect(orgMember).toBeNull()
    const groupMember = await env.AQUILLA_DB.prepare("SELECT user_id FROM group_members WHERE group_id = 10 AND user_id = 2").first()
    expect(groupMember).toBeNull() // cascaded
  })
})
