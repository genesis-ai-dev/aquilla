import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

async function getOrgs(username: string) {
  const res = await app.request("/api/v2/orgs", { headers: authHeader(await jwtFor(username)) }, env)
  return { status: res.status, body: (await res.json()) as { orgs: Array<{ id: number; name: string | null; role: { level: number; name: string } }> } }
}

describe("GET /api/v2/orgs", () => {
  it("returns owned + member orgs with resolved roles", async () => {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'annas workspace', 2)").run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (2, 2, 700, 2)",
    ).run()

    const { status, body } = await getOrgs("anna")
    expect(status).toBe(200)
    const byId = Object.fromEntries(body.orgs.map((o) => [o.id, o]))
    expect(byId[1].role.level).toBe(600) // Come and See, via membership
    expect(byId[1].name).toBe("Come and See")
    expect(byId[2].role.level).toBe(700) // own workspace
  })

  it("lazy-creates a personal org for a brand-new user", async () => {
    await seedUser(3, "newbie")
    const { status, body } = await getOrgs("newbie")
    expect(status).toBe(200)
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0].role.level).toBe(700)
    expect(body.orgs[0].name).toBe("newbie's workspace")
  })

  it("does not list an org the caller has no membership in", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_DB.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1), (2, 'Bob Org', 2)").run()
    await env.AQUILLA_DB.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 2, 700, 2)").run()
    const { body } = await getOrgs("alice")
    expect(body.orgs.map((o) => o.id)).toEqual([1])
  })
})
