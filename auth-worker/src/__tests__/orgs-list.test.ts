import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function getOrgs(username: string) {
  const res = await app.request("/api/v2/orgs", { headers: authHeader(await jwtFor(username)) }, env)
  return { status: res.status, body: (await res.json()) as { orgs: Array<{ id: number; name: string | null; role: { level: number; name: string } }> } }
}

describe("GET /api/v2/orgs", () => {
  it("returns owned + member orgs with resolved roles", async () => {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'annas workspace', 2)").run()
    await env.AQUILLA_PG.prepare(
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

  // The org switcher pins the personal workspace to the top with a Home tag;
  // it can only do that if the server says which org is personal. Owning a
  // team org must not count — only the findPersonalOrg resolution does.
  it("tags only the caller's personal workspace as personal", async () => {
    await seedUser(4, "pat")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (40, 'pats workspace', 4, 'personal'), (41, 'Pat Team', 4, 'team')",
    ).run()
    const res = await app.request("/api/v2/orgs", { headers: authHeader(await jwtFor("pat")) }, env)
    const body = (await res.json()) as { orgs: Array<{ id: number; personal?: boolean }> }
    const byId = Object.fromEntries(body.orgs.map((o) => [Number(o.id), o]))
    expect(byId[40].personal).toBe(true)
    expect(byId[41].personal).toBeUndefined()
  })

  it("does not list an org the caller has no membership in", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1), (2, 'Bob Org', 2)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 2, 700, 2)").run()
    const { body } = await getOrgs("alice")
    expect(body.orgs.map((o) => o.id)).toEqual([1])
  })
})
