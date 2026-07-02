import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// GET /api/v2/orgs/:orgId/project-invites used to share its path with
// GET /api/v2/orgs/:orgId/invites (org_invites listing) — Hono dispatched to
// whichever handler was registered first, permanently shadowing this one.
// The Roster's "Pending invitations" section then rendered org_invites rows
// (which have no createdBy) through the PendingOrgInvite shape, crashing on
// `invite.createdBy.username`. This asserts the correct handler is live and
// always includes createdBy.

async function seedOrgWithProject(): Promise<void> {
  await seedUser(1, "wendi")
  await seedUser(2, "tom")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Genesis', 1, 1)",
  ).run()
}

describe("GET /api/v2/orgs/:orgId/project-invites", () => {
  beforeEach(seedOrgWithProject)

  it("lists project invites with createdBy populated, including open (no-email) links", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at)
       VALUES ('tok-open-aaaa', 'proj-1', 400, 1, NULL, NULL)`,
    ).run()

    const res = await app.request(
      "/api/v2/orgs/1/project-invites",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      invites: Array<{
        token: string
        projectId: string
        projectName: string
        createdBy: { userId: number; username: string }
        email: string | null
      }>
    }
    expect(body.invites).toHaveLength(1)
    expect(body.invites[0]).toMatchObject({
      token: "tok-open-aaaa",
      projectId: "proj-1",
      projectName: "Genesis",
      createdBy: { userId: 1, username: "wendi" },
      email: null,
    })
  })

  it("rejects a non-owner with 403", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/orgs/1/project-invites",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})
