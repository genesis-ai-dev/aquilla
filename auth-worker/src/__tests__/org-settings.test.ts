import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

/** Seed one org with wendi=owner (700), anna=maintainer (600), tom=contributor (400). */
async function seedOrg() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "tom")
  await seedUser(4, "stranger")
  await env.AQUILLA_DB.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 400, 1)`,
  ).run()
}

const GET = async (username: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(username)) }, env)

const PUT = async (
  username: string,
  body: Record<string, unknown>,
) =>
  app.request("/api/v2/orgs/1/settings", {
    method: "PUT",
    headers: authHeader(await jwtFor(username)),
    body: JSON.stringify(body),
  }, env)

describe("GET /api/v2/orgs/:orgId/settings", () => {
  it("returns empty settings at version 0 for an org member", async () => {
    await seedOrg()
    const res = await GET("wendi")
    expect(res.status).toBe(200)
    const body = await res.json() as { orgId: number; version: number; settings: Record<string, unknown> }
    expect(body.orgId).toBe(1)
    expect(body.version).toBe(0)
    expect(body.settings).toEqual({})
  })

  it("returns 200 for a contributor (read-only member)", async () => {
    await seedOrg()
    const res = await GET("tom")
    expect(res.status).toBe(200)
  })

  it("returns 403 for a non-member", async () => {
    await seedOrg()
    const res = await GET("stranger")
    expect(res.status).toBe(403)
  })
})

describe("PUT /api/v2/orgs/:orgId/settings", () => {
  it("returns 403 when ifMatchVersion is missing", async () => {
    await seedOrg()
    const res = await PUT("wendi", { settings: { rules: [] } })
    expect(res.status).toBe(400)
  })

  it("returns 403 for a contributor (below maintainer)", async () => {
    await seedOrg()
    const res = await PUT("tom", { settings: { rules: [] }, ifMatchVersion: 0 })
    expect(res.status).toBe(403)
  })

  it("returns 403 for a non-member", async () => {
    await seedOrg()
    const res = await PUT("stranger", { settings: { rules: [] }, ifMatchVersion: 0 })
    expect(res.status).toBe(403)
  })

  it("maintainer can write settings and version increments", async () => {
    await seedOrg()
    const rule = { id: "r1", name: "No slang", severity: "minor", scope: "org", source: "user", description: "", enabled: true, check: { type: "target-forbids", targetPattern: "slang" }, createdAt: new Date().toISOString() }
    const res = await PUT("anna", { settings: { rules: [rule] }, ifMatchVersion: 0 })
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number; settings: { rules: unknown[] } }
    expect(body.version).toBe(1)
    expect((body.settings.rules as unknown[]).length).toBe(1)
  })

  it("owner can write settings", async () => {
    await seedOrg()
    const res = await PUT("wendi", { settings: { rules: [] }, ifMatchVersion: 0 })
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number }
    expect(body.version).toBe(1)
  })

  it("second write must supply the updated version", async () => {
    await seedOrg()
    await PUT("wendi", { settings: { rules: [] }, ifMatchVersion: 0 })
    // Re-send with old version → 409
    const res = await PUT("wendi", { settings: { rules: [] }, ifMatchVersion: 0 })
    expect(res.status).toBe(409)
    // Re-send with new version → 200
    const res2 = await PUT("wendi", { settings: { rules: [] }, ifMatchVersion: 1 })
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { version: number }
    expect(body2.version).toBe(2)
  })
})
