// AQU-471: invite previews carry "who invited you, to what org" so a recipient
// (e.g. Bob invited by Wendi) isn't looking at a generic page. The email-copy
// builders are covered separately in invite-email-context.test.ts; this file
// covers the preview endpoints (org + project + multi).
import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// Org 1 "Come and See" owned by wendi(1); project "pa" lives in it; "solo" has
// no org. wendi has a display_name so previews exercise the COALESCE path.
async function seedWorld(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(3, "bob")
  await env.AQUILLA_PG.prepare(
    "UPDATE users SET display_name = 'Wendi M.' WHERE id = 1",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Kilisusu NT', 1, 1), ('solo', 'Orgless', NULL, 1)",
  ).run()
}

describe("project invite previews carry inviter + org (AQU-471)", () => {
  beforeEach(seedWorld)

  it("single-project preview returns invitedBy and orgName", async () => {
    const created = await app.request(
      "/api/v2/projects/pa/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({}) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      projectName: "Kilisusu NT",
      orgName: "Come and See",
      invitedBy: "Wendi M.",
    })
  })

  it("single-project preview tolerates an org-less project", async () => {
    const created = await app.request(
      "/api/v2/projects/solo/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({}) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ orgName: null, invitedBy: "Wendi M." })
  })

  it("multi-project preview returns invitedBy and per-project orgName", async () => {
    const created = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ projectIds: ["pa", "solo"] }),
      },
      env,
    )
    expect(created.status).toBe(200)
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/invites/${token}/preview`, {}, env)
    expect(preview.status).toBe(200)
    const body = (await preview.json()) as {
      invitedBy: string
      projects: { projectId: string; orgName: string | null }[]
    }
    expect(body.invitedBy).toBe("Wendi M.")
    const byId = new Map(body.projects.map((p) => [p.projectId, p.orgName]))
    expect(byId.get("pa")).toBe("Come and See")
    expect(byId.get("solo")).toBeNull()
  })
})

describe("GET /api/v2/orgs/invite-preview/:token (public, AQU-471)", () => {
  beforeEach(seedWorld)

  async function mintOrgInvite(body: Record<string, unknown> = {}): Promise<string> {
    const res = await app.request(
      "/api/v2/orgs/1/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify(body) },
      env,
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { token: string }).token
  }

  it("returns org name, inviter, and role WITHOUT auth", async () => {
    const token = await mintOrgInvite({ role: 400, email: "bob@example.com" })
    const res = await app.request(`/api/v2/orgs/invite-preview/${token}`, {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      orgId: 1,
      orgName: "Come and See",
      invitedBy: "Wendi M.",
      role: { level: 400 },
      email: "bob@example.com",
    })
  })

  it("returns 410 with code time_expired for an expired invite", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, expires_at)
       VALUES ('expiredtoken1234567890abcdef0000', 1, 400, 1, '2000-01-01T00:00:00Z')`,
    ).run()
    const res = await app.request(
      "/api/v2/orgs/invite-preview/expiredtoken1234567890abcdef0000",
      {},
      env,
    )
    expect(res.status).toBe(410)
    expect(((await res.json()) as { code: string }).code).toBe("time_expired")
  })

  it("returns 410 with code used for a redeemed invite (anonymous caller)", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, used_by, used_at)
       VALUES ('usedtoken1234567890abcdef00000000', 1, 400, 1, 3, CURRENT_TIMESTAMP)`,
    ).run()
    const res = await app.request(
      "/api/v2/orgs/invite-preview/usedtoken1234567890abcdef00000000",
      {},
      env,
    )
    expect(res.status).toBe(410)
    expect(((await res.json()) as { code: string }).code).toBe("used")
  })

  it("AQU-347: still-member original redeemer re-clicking a used invite gets 200", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, used_by, used_at)
       VALUES ('rememberme1234567890abcdef000000', 1, 400, 1, 3, CURRENT_TIMESTAMP)`,
    ).run()
    // bob(3) redeemed and is still an org member.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 3, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/orgs/invite-preview/rememberme1234567890abcdef000000",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orgId: 1, orgName: "Come and See" })
  })

  it("AQU-347: removed original redeemer re-clicking a used invite still gets 410", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_invites (token, org_id, role_level, created_by, used_by, used_at)
       VALUES ('gonenow1234567890abcdef000000000', 1, 400, 1, 3, CURRENT_TIMESTAMP)`,
    ).run()
    // bob(3) redeemed but is NOT an org member anymore.
    const res = await app.request(
      "/api/v2/orgs/invite-preview/gonenow1234567890abcdef000000000",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(410)
    expect(((await res.json()) as { code: string }).code).toBe("used")
  })

  it("returns 404 for an unknown or too-short token", async () => {
    const unknown = await app.request(
      "/api/v2/orgs/invite-preview/doesnotexist1234567890abcdef0000",
      {},
      env,
    )
    expect(unknown.status).toBe(404)
    const short = await app.request("/api/v2/orgs/invite-preview/abc", {}, env)
    expect(short.status).toBe(404)
  })
})
