import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-1579: an email-bound invite is redeemed only when the account has
// proven it owns that address (users.email_verified_at). Registration does
// not set the flag; POST /auth/verify-email does. Open invites are unchanged.

const INVITEE_ID = 2

async function verifyInvitee(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(INVITEE_ID)
    .run()
}

beforeEach(async () => {
  await seedUser(1, "owner")
  await seedUser(INVITEE_ID, "invitee")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Genesis', 1, 1)",
  ).run()
})

async function seedOrgInvite(token: string, email: string | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_invites (token, org_id, role_level, created_by, email)
     VALUES (?, 1, 400, 1, ?)`,
  )
    .bind(token, email)
    .run()
}

async function seedProjectInvite(token: string, email: string | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_invites (token, project_id, role_level, created_by, email)
     VALUES (?, 'proj-1', 400, 1, ?)`,
  )
    .bind(token, email)
    .run()
}

async function acceptOrg(token: string): Promise<Response> {
  return app.request(
    "/api/v2/orgs/accept-invite",
    {
      method: "POST",
      headers: authHeader(await jwtFor("invitee")),
      body: JSON.stringify({ token }),
    },
    env,
  )
}

async function acceptProject(token: string): Promise<Response> {
  return app.request(
    "/api/v2/projects/accept-invite",
    {
      method: "POST",
      headers: authHeader(await jwtFor("invitee")),
      body: JSON.stringify({ token }),
    },
    env,
  )
}

async function acceptMulti(token: string): Promise<Response> {
  return app.request(
    `/api/v2/invites/${token}/accept`,
    { method: "POST", headers: authHeader(await jwtFor("invitee")) },
    env,
  )
}

type ErrorBody = { error: string; code?: string }

async function expectUnverifiedRejection(res: Response): Promise<void> {
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(res.status).toBeLessThan(500)
  const body = (await res.json()) as ErrorBody
  expect(body.code).toBe("email_unverified")
  expect(body.error).toMatch(/verify your email/i)
}

describe("AQU-1579 email-bound org invite", () => {
  it("rejects an unverified account whose email matches", async () => {
    await seedOrgInvite("org-unverified-token-000000000001", "invitee@example.com")
    const res = await acceptOrg("org-unverified-token-000000000001")
    await expectUnverifiedRejection(res)

    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = ?",
    )
      .bind(INVITEE_ID)
      .first()
    expect(member).toBeNull()
    const invite = await env.AQUILLA_PG.prepare(
      "SELECT used_by, used_at FROM org_invites WHERE token = ?",
    )
      .bind("org-unverified-token-000000000001")
      .first<{ used_by: number | null; used_at: string | null }>()
    expect(invite?.used_by).toBeNull()
    expect(invite?.used_at).toBeNull()
  })

  it("accepts a verified account whose email matches, at the invited role", async () => {
    await verifyInvitee()
    await seedOrgInvite("org-verified-token-0000000000001", "INVITEE@example.com")
    const res = await acceptOrg("org-verified-token-0000000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number } }
    expect(body.role.level).toBe(400)
    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = ?",
    )
      .bind(INVITEE_ID)
      .first<{ role_level: number }>()
    expect(member?.role_level).toBe(400)
  })

  it("still lets an unverified account redeem an invite with no bound email", async () => {
    await seedOrgInvite("org-open-token-0000000000000001", null)
    const res = await acceptOrg("org-open-token-0000000000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number } }
    expect(body.role.level).toBe(400)
  })
})

describe("AQU-1579 email-bound project invite", () => {
  it("rejects an unverified account whose email matches", async () => {
    await seedProjectInvite("proj-unverified-token-0000000001", "invitee@example.com")
    const res = await acceptProject("proj-unverified-token-0000000001")
    await expectUnverifiedRejection(res)

    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-1' AND user_id = ?",
    )
      .bind(INVITEE_ID)
      .first()
    expect(member).toBeNull()
    const invite = await env.AQUILLA_PG.prepare(
      "SELECT used_by, used_at FROM project_invites WHERE token = ?",
    )
      .bind("proj-unverified-token-0000000001")
      .first<{ used_by: number | null; used_at: string | null }>()
    expect(invite?.used_by).toBeNull()
    expect(invite?.used_at).toBeNull()
  })

  it("accepts a verified account whose email matches, at the invited role", async () => {
    await verifyInvitee()
    await seedProjectInvite("proj-verified-token-000000000001", "Invitee@Example.com")
    const res = await acceptProject("proj-verified-token-000000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    expect(body.role).toBe(400)
  })

  it("still lets an unverified account redeem an invite with no bound email", async () => {
    await seedProjectInvite("proj-open-token-00000000000001", null)
    const res = await acceptProject("proj-open-token-00000000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    expect(body.role).toBe(400)
  })
})

describe("AQU-1579 email-bound multi invite accept", () => {
  it("rejects an unverified account whose email matches", async () => {
    await seedProjectInvite("multi-unverified-token-000000001", "invitee@example.com")
    const res = await acceptMulti("multi-unverified-token-000000001")
    await expectUnverifiedRejection(res)

    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-1' AND user_id = ?",
    )
      .bind(INVITEE_ID)
      .first()
    expect(member).toBeNull()
    const invite = await env.AQUILLA_PG.prepare(
      "SELECT used_by, used_at FROM project_invites WHERE token = ?",
    )
      .bind("multi-unverified-token-000000001")
      .first<{ used_by: number | null; used_at: string | null }>()
    expect(invite?.used_by).toBeNull()
    expect(invite?.used_at).toBeNull()
  })

  it("accepts a verified account whose email matches, at the invited role", async () => {
    await verifyInvitee()
    await seedProjectInvite("multi-verified-token-00000000001", "invitee@example.com")
    const res = await acceptMulti("multi-verified-token-00000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: Array<{ projectId: string; role: number }> }
    expect(body.accepted).toEqual([{ projectId: "proj-1", role: 400 }])
  })

  it("still lets an unverified account redeem an invite with no bound email", async () => {
    await seedProjectInvite("multi-open-token-0000000000001", null)
    const res = await acceptMulti("multi-open-token-0000000000001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: Array<{ projectId: string; role: number }> }
    expect(body.accepted).toEqual([{ projectId: "proj-1", role: 400 }])
  })
})
