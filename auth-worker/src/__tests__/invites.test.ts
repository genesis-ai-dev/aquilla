import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

describe("POST /api/v2/projects/:id/invites", () => {
  it("creates an invite for the project creator and caps role at contributor", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
    )
      .bind("proj-1", "Test", 1)
      .run()
    const res = await app.request(
      "/api/v2/projects/proj-1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        // Try to mint an OWNER-level link; server should cap to CONTRIBUTOR.
        body: JSON.stringify({ role: 700 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      projectId: string
      role: number
    }
    expect(body.projectId).toBe("proj-1")
    expect(body.role).toBe(400)
    expect(body.token.length).toBeGreaterThan(8)
    const invites = await env.AQUILLA_PG.prepare(
      "SELECT token FROM project_invites WHERE project_id = 'proj-1'",
    ).all()
    expect(invites.results).toHaveLength(1)
  })

  it("rejects users without project_lead+ role with 403", async () => {
    await seedUser(2, "bob")
    await seedUser(99, "creator")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 99)",
    )
      .bind("proj-1", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 99)",
    )
      .bind("proj-1", 2, 400)
      .run()
    const res = await app.request(
      "/api/v2/projects/proj-1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ role: 400 }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns 404 for unknown projects", async () => {
    await seedUser(1, "alice")
    const res = await app.request(
      "/api/v2/projects/proj-missing/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ role: 400 }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/v2/projects/accept-invite", () => {
  it("adds the caller to project_members and stamps the invite", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("proj-1", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "share-token-abc",
        "proj-1",
        400,
        1,
        new Date(Date.now() + 86400000).toISOString(),
      )
      .run()
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token: "share-token-abc" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; role: number }
    expect(body).toEqual({ projectId: "proj-1", role: 400 })

    const members = await env.AQUILLA_PG.prepare(
      "SELECT project_id, user_id, role_level FROM project_members WHERE project_id = 'proj-1'",
    ).all<{ project_id: string; user_id: number; role_level: number }>()
    expect(members.results).toHaveLength(1)
    expect(members.results[0]).toMatchObject({
      project_id: "proj-1",
      user_id: 2,
      role_level: 400,
    })
    const invite = await env.AQUILLA_PG.prepare(
      "SELECT used_by, used_at FROM project_invites WHERE token = 'share-token-abc'",
    ).first<{ used_by: number | null; used_at: string | null }>()
    expect(invite?.used_by).toBe(2)
    expect(invite?.used_at).not.toBeNull()
  })

  it("rejects expired invites with 410", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("proj-1", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "expired-tok",
        "proj-1",
        400,
        1,
        new Date(Date.now() - 60000).toISOString(),
      )
      .run()
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token: "expired-tok" }),
      },
      env,
    )
    expect(res.status).toBe(410)
  })

  it("rejects unknown tokens with 404", async () => {
    await seedUser(2, "bob")
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token: "no-such-token" }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it("doesn't demote a maintainer who redeems a contributor invite", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("proj-1", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind("proj-1", 2, 600)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "share-tok",
        "proj-1",
        400,
        1,
        new Date(Date.now() + 86400000).toISOString(),
      )
      .run()
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token: "share-tok" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    expect(body.role).toBe(600)
  })
})

describe("GET /api/v2/projects/invite-preview/:token", () => {
  it("returns project + role metadata for a valid token (no auth)", async () => {
    await seedUser(1, "creator")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("proj-1", "Genesis MVP")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "share-tok",
        "proj-1",
        400,
        1,
        new Date(Date.now() + 86400000).toISOString(),
      )
      .run()
    const res = await app.request(
      "/api/v2/projects/invite-preview/share-tok",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      projectName: string
      role: { level: number; name: string }
    }
    expect(body.projectId).toBe("proj-1")
    expect(body.projectName).toBe("Genesis MVP")
    expect(body.role).toEqual({ level: 400, name: "contributor" })
  })

  it("404s on unknown tokens", async () => {
    const res = await app.request(
      "/api/v2/projects/invite-preview/bogus",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(404)
  })
})

// ── Multi-project invite acceptance (RACE-7 fixes) ───────────────────────────

describe("POST /api/v2/invites/:token/accept — idempotency and race guard", () => {
  async function seedMultiInvite(token: string, projectId: string, creatorId: number) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(token, projectId, 400, creatorId, new Date(Date.now() + 86_400_000).toISOString())
      .run()
  }

  it("accepts and stamps the invite for a fresh token", async () => {
    await seedUser(10, "alice")
    await seedUser(11, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 10)",
    )
      .bind("proj-multi-1", "Multi Test")
      .run()
    await seedMultiInvite("tok-multi-1", "proj-multi-1", 10)

    const res = await app.request(
      "/api/v2/invites/tok-multi-1/accept",
      { method: "POST", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; accepted: Array<{ projectId: string; role: number }> }
    expect(body.accepted).toHaveLength(1)
    expect(body.accepted[0]).toMatchObject({ projectId: "proj-multi-1", role: 400 })

    // Membership row created
    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = 11",
    )
      .bind("proj-multi-1")
      .first<{ role_level: number }>()
    expect(member?.role_level).toBe(400)

    // Invite stamped
    const invite = await env.AQUILLA_PG.prepare(
      "SELECT used_by, used_at FROM project_invites WHERE token = ? AND project_id = ?",
    )
      .bind("tok-multi-1", "proj-multi-1")
      .first<{ used_by: number | null; used_at: string | null }>()
    expect(invite?.used_by).toBe(11)
    expect(invite?.used_at).not.toBeNull()
  })

  it("same user double-click is idempotent — returns 200, not 500", async () => {
    await seedUser(20, "carol")
    await seedUser(21, "dave")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 20)",
    )
      .bind("proj-multi-2", "Double Click Test")
      .run()
    await seedMultiInvite("tok-dc", "proj-multi-2", 20)

    // First accept
    const r1 = await app.request(
      "/api/v2/invites/tok-dc/accept",
      { method: "POST", headers: authHeader(await jwtFor("dave")) },
      env,
    )
    expect(r1.status).toBe(200)

    // Second accept by same user — should be idempotent (200, not 500 or 410)
    const r2 = await app.request(
      "/api/v2/invites/tok-dc/accept",
      { method: "POST", headers: authHeader(await jwtFor("dave")) },
      env,
    )
    expect(r2.status).toBe(200)
    const body2 = (await r2.json()) as { accepted: Array<{ projectId: string }> }
    // dave is still in the accepted list (re-accept by same user is idempotent)
    expect(body2.accepted.some((a) => a.projectId === "proj-multi-2")).toBe(true)
  })

  it("second user with a forwarded single-use link is rejected after the first user claims it", async () => {
    await seedUser(30, "eve")
    await seedUser(31, "frank")
    await seedUser(32, "grace")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 30)",
    )
      .bind("proj-multi-3", "Single Use Test")
      .run()
    await seedMultiInvite("tok-single-use", "proj-multi-3", 30)

    // Frank accepts first
    const r1 = await app.request(
      "/api/v2/invites/tok-single-use/accept",
      { method: "POST", headers: authHeader(await jwtFor("frank")) },
      env,
    )
    expect(r1.status).toBe(200)

    // Grace (different user) tries to use the same link afterward — row is
    // already stamped with used_at IS NOT NULL and used_by != grace's id, so
    // the invite row is skipped; accepted list is empty → 410.
    const r2 = await app.request(
      "/api/v2/invites/tok-single-use/accept",
      { method: "POST", headers: authHeader(await jwtFor("grace")) },
      env,
    )
    expect(r2.status).toBe(410)

    // Grace must NOT be in project_members
    const member = await env.AQUILLA_PG.prepare(
      "SELECT user_id FROM project_members WHERE project_id = ? AND user_id = 32",
    )
      .bind("proj-multi-3")
      .first<{ user_id: number }>()
    expect(member).toBeNull()
  })
})
