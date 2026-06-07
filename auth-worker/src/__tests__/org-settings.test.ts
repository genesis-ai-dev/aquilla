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

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/orgs/:orgId/rule-promotion-requests
// ──────────────────────────────────────────────────────────────────────────

/** Seed org with wendi=owner(700), anna=maintainer(600), lead=project_lead(500), tom=contributor(400), stranger=no membership. */
async function seedOrgWithLead() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "lead")
  await seedUser(4, "tom")
  await seedUser(5, "stranger")
  await env.AQUILLA_DB.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 500, 1),
      (1, 4, 400, 1)`,
  ).run()
}

const sampleRule = {
  id: "rule-1",
  name: "No slang",
  description: "Avoid slang",
  severity: "minor",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "slang" },
  enabled: true,
  createdAt: new Date().toISOString(),
}

const POST_PR = async (username: string, body: Record<string, unknown>) =>
  app.request("/api/v2/orgs/1/rule-promotion-requests", {
    method: "POST",
    headers: authHeader(await jwtFor(username)),
    body: JSON.stringify(body),
  }, env)

describe("POST /api/v2/orgs/:orgId/rule-promotion-requests", () => {
  it("project_lead (500) can submit a promotion request — appears in settings blob", async () => {
    await seedOrgWithLead()
    const res = await POST_PR("lead", { rule: sampleRule, sourceProjectId: "proj-abc" })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; request: { id: string; rule: { id: string } } }
    expect(body.ok).toBe(true)
    expect(body.request.rule.id).toBe("rule-1")

    // Verify the request is stored in the org settings blob.
    const settingsRes = await app.request("/api/v2/orgs/1/settings", {
      headers: authHeader(await jwtFor("wendi")),
    }, env)
    const settings = await settingsRes.json() as { settings: { promotionRequests?: Array<{ rule: { id: string } }> } }
    expect(settings.settings.promotionRequests).toHaveLength(1)
    expect(settings.settings.promotionRequests![0].rule.id).toBe("rule-1")
  })

  it("contributor (400) gets 403", async () => {
    await seedOrgWithLead()
    const res = await POST_PR("tom", { rule: sampleRule, sourceProjectId: "proj-abc" })
    expect(res.status).toBe(403)
  })

  it("non-member gets 403", async () => {
    await seedOrgWithLead()
    const res = await POST_PR("stranger", { rule: sampleRule, sourceProjectId: "proj-abc" })
    expect(res.status).toBe(403)
  })

  it("duplicate request (same rule id + project) returns 409", async () => {
    await seedOrgWithLead()
    const first = await POST_PR("lead", { rule: sampleRule, sourceProjectId: "proj-abc" })
    expect(first.status).toBe(200)
    const second = await POST_PR("lead", { rule: sampleRule, sourceProjectId: "proj-abc" })
    expect(second.status).toBe(409)
  })

  it("maintainer PUT can approve (promotes rule, clears request); version increments", async () => {
    await seedOrgWithLead()
    // Submit a promotion request as project_lead.
    await POST_PR("lead", { rule: sampleRule, sourceProjectId: "proj-abc" })

    // Read current settings to get version.
    const readRes = await app.request("/api/v2/orgs/1/settings", {
      headers: authHeader(await jwtFor("anna")),
    }, env)
    const { settings: currentSettings, version } = await readRes.json() as {
      settings: { promotionRequests?: Array<{ id: string; rule: typeof sampleRule }> }
      version: number
    }
    const req = currentSettings.promotionRequests![0]

    // Maintainer approves: promotes rule to org scope, removes request.
    const promotedRule = { ...req.rule, id: "promoted-" + req.rule.id, scope: "org", createdAt: new Date().toISOString() }
    const approveRes = await app.request("/api/v2/orgs/1/settings", {
      method: "PUT",
      headers: authHeader(await jwtFor("anna")),
      body: JSON.stringify({
        settings: { rules: [promotedRule], promotionRequests: [] },
        ifMatchVersion: version,
      }),
    }, env)
    expect(approveRes.status).toBe(200)
    const approveBody = await approveRes.json() as { version: number; settings: { rules: unknown[]; promotionRequests?: unknown[] } }
    expect(approveBody.version).toBe(version + 1)
    expect(approveBody.settings.rules).toHaveLength(1)
    expect(approveBody.settings.promotionRequests).toHaveLength(0)
  })
})
