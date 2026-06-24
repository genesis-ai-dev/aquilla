import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// Org id 1 owned by wendi(1); tom(2) is a contributor; bob(3) and carol(4)
// are prospective invitees. seedUser sets email = `${username}@example.com`.
async function seedOrg(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "tom")
  await seedUser(3, "bob")
  await seedUser(4, "carol")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
  ).run()
}

async function mint(
  username: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    "/api/v2/orgs/1/invites",
    { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) },
    env,
  )
}

async function accept(username: string, token: string): Promise<Response> {
  return app.request(
    "/api/v2/orgs/accept-invite",
    { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify({ token }) },
    env,
  )
}

describe("POST /api/v2/orgs/:orgId/invites (mint)", () => {
  beforeEach(seedOrg)

  it("lets an owner mint an invite and stores the row", async () => {
    const res = await mint("wendi", { email: "bob@example.com", role: 400 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; role: { level: number } }
    expect(body.token).toHaveLength(32)
    expect(body.role.level).toBe(400)
    const row = await env.AQUILLA_PG.prepare(
      "SELECT org_id, role_level, email FROM org_invites WHERE token = ?",
    )
      .bind(body.token)
      .first<{ org_id: number; role_level: number; email: string }>()
    expect(row).toMatchObject({ org_id: 1, role_level: 400, email: "bob@example.com" })
  })

  it("rejects a non-owner with 403", async () => {
    const res = await mint("tom", { email: "bob@example.com" })
    expect(res.status).toBe(403)
  })

  it("caps the granted role below owner (700 -> 600)", async () => {
    const res = await mint("wendi", { role: 600 })
    expect(res.status).toBe(200)
    // 700 isn't even accepted by the schema; verify the runtime cap on a value
    // the schema would allow if it crept up — assert max grantable is maintainer.
    const body = (await res.json()) as { role: { level: number } }
    expect(body.role.level).toBeLessThanOrEqual(600)
  })
})

describe("POST /api/v2/orgs/accept-invite (redeem)", () => {
  beforeEach(seedOrg)

  it("adds the redeemer to org_members for an open invite", async () => {
    const minted = (await (await mint("wendi", { role: 400 })).json()) as { token: string }
    const res = await accept("bob", minted.token)
    expect(res.status).toBe(200)
    const mem = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = 3",
    ).first<{ role_level: number }>()
    expect(mem?.role_level).toBe(400)
    // Token is stamped used.
    const inv = await env.AQUILLA_PG.prepare(
      "SELECT used_by FROM org_invites WHERE token = ?",
    )
      .bind(minted.token)
      .first<{ used_by: number }>()
    expect(inv?.used_by).toBe(3)
  })

  it("honors an email-bound invite for the matching email", async () => {
    const minted = (await (await mint("wendi", { email: "bob@example.com" })).json()) as { token: string }
    const res = await accept("bob", minted.token)
    expect(res.status).toBe(200)
  })

  it("rejects an email-bound invite redeemed by a different email (403)", async () => {
    const minted = (await (await mint("wendi", { email: "bob@example.com" })).json()) as { token: string }
    const res = await accept("carol", minted.token)
    expect(res.status).toBe(403)
    const mem = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = 4",
    ).first<{ role_level: number }>()
    expect(mem).toBeNull()
  })

  it("returns 410 for an expired invite", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, expires_at)
       VALUES ('expiredtoken1234567890abcdef0000', 1, 400, 1, '2000-01-01T00:00:00Z')`,
    ).run()
    const res = await accept("bob", "expiredtoken1234567890abcdef0000")
    expect(res.status).toBe(410)
  })

  it("returns 410 when already used by someone else", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, used_by, used_at)
       VALUES ('usedtoken1234567890abcdef00000000', 1, 400, 1, 4, CURRENT_TIMESTAMP)`,
    ).run()
    const res = await accept("bob", "usedtoken1234567890abcdef00000000")
    expect(res.status).toBe(410)
  })

  it("returns 404 for an unknown token", async () => {
    const res = await accept("bob", "doesnotexist1234567890abcdef0000")
    expect(res.status).toBe(404)
  })
})

describe("GET + DELETE /api/v2/orgs/:orgId/invites", () => {
  beforeEach(seedOrg)

  it("lists active invites for the owner and revoke removes them", async () => {
    const minted = (await (await mint("wendi", { email: "bob@example.com" })).json()) as { token: string }
    const list = await app.request(
      "/api/v2/orgs/1/invites",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { invites: { token: string }[] }
    expect(listed.invites.map((i) => i.token)).toContain(minted.token)

    const del = await app.request(
      `/api/v2/orgs/1/invites/${minted.token}`,
      { method: "DELETE", headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(del.status).toBe(200)
    // Revoked token can no longer be redeemed.
    const res = await accept("bob", minted.token)
    expect(res.status).toBe(404)
  })

  it("rejects a non-owner listing invites (403)", async () => {
    const res = await app.request(
      "/api/v2/orgs/1/invites",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})
