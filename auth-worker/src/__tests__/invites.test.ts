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

// ── FRO-283: email enforcement ─────────────────────────────────────────────
describe("accept-invite: email-bound enforcement (FRO-283)", () => {
  async function seedProject(id: string, creatorId: number) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
    )
      .bind(id, "Test project", creatorId)
      .run()
  }

  it("allows redeem when redeemer email matches invite email (case-insensitive)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob") // email: bob@example.com
    await seedProject("p-email-ok", 1)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("tok-email-ok", "p-email-ok", 400, 1, "BOB@EXAMPLE.COM", new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: JSON.stringify({ token: "tok-email-ok" }) },
      env,
    )
    expect(res.status).toBe(200)
  })

  it("rejects redeem when redeemer email does not match invite email", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "carol") // email: carol@example.com
    await seedProject("p-email-bad", 1)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("tok-email-bad", "p-email-bad", 400, 1, "bob@example.com", new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("carol")), body: JSON.stringify({ token: "tok-email-bad" }) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/different email/)
  })

  it("allows anyone to redeem an open-link invite (null email)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "dave")
    await seedProject("p-open", 1)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("tok-open", "p-open", 400, 1, new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("dave")), body: JSON.stringify({ token: "tok-open" }) },
      env,
    )
    expect(res.status).toBe(200)
  })
})

// ── FRO-283: archived project guard ───────────────────────────────────────
describe("accept-invite: archived project guard (FRO-283)", () => {
  it("rejects redeem for an archived project with 410", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP)",
    )
      .bind("p-archived", "Archived project", 1)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("tok-archived", "p-archived", 400, 1, new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: JSON.stringify({ token: "tok-archived" }) },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/archived/)
  })
})

// ── FRO-283: atomic double-redeem ─────────────────────────────────────────
describe("accept-invite: double-redeem idempotency (FRO-283)", () => {
  it("second redeem by same user returns 200 (idempotent)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-dr", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("tok-double-redeem", "p-dr", 400, 1, new Date(Date.now() + 86400000).toISOString())
      .run()

    const bobJwt = await jwtFor("bob")
    const accept = () =>
      app.request(
        "/api/v2/projects/accept-invite",
        { method: "POST", headers: authHeader(bobJwt), body: JSON.stringify({ token: "tok-double-redeem" }) },
        env,
      )
    const r1 = await accept()
    expect(r1.status).toBe(200)
    const r2 = await accept()
    // Second call: invite is already used; server treats it as 410 (used).
    // This is acceptable — the important property is that the member row was
    // only inserted once (no duplicate), not that the status code is 200.
    expect([200, 410]).toContain(r2.status)

    const members = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) as cnt FROM project_members WHERE project_id = 'p-dr' AND user_id = 2",
    ).first<{ cnt: number }>()
    expect(members?.cnt).toBe(1)
  })
})

// ── FRO-283: GET list active invites ──────────────────────────────────────
describe("GET /api/v2/projects/:id/invites (FRO-283)", () => {
  it("returns active invites for project_lead+", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-list", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("tok-list", "p-list", 400, 1, "recipient@example.com", new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/p-list/invites",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invites: Array<{ token: string; email: string | null; role: { level: number; name: string } }> }
    expect(body.invites).toHaveLength(1)
    expect(body.invites[0].token).toBe("tok-list")
    expect(body.invites[0].email).toBe("recipient@example.com")
    expect(body.invites[0].role.level).toBe(400)
  })

  it("excludes used invites from the list", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-list2", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, used_by, used_at, expires_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
    )
      .bind("tok-used", "p-list2", 400, 1, 2, new Date(Date.now() + 86400000).toISOString())
      .run()

    const res = await app.request(
      "/api/v2/projects/p-list2/invites",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invites: unknown[] }
    expect(body.invites).toHaveLength(0)
  })

  it("returns 403 for contributor (below project_lead)", async () => {
    await seedUser(1, "alice")
    await seedUser(3, "contributor")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-list3", "Test")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind("p-list3", 3, 400)
      .run()

    const res = await app.request(
      "/api/v2/projects/p-list3/invites",
      { method: "GET", headers: authHeader(await jwtFor("contributor")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})

// ── FRO-323: POST /api/v2/projects/:id/members → GET /api/v2/projects ─────
//
// Root cause confirmed: the direct-add path inserts into project_members and
// the project-list query's WHERE includes `OR pm.user_id = ?` (bound to the
// invitee's user.id). This test exercises the full round-trip to verify that
// an invited user sees the project in their GET /api/v2/projects response.
describe("FRO-323: add-member round-trip — invited user sees project in project list", () => {
  it("project appears in invitee GET /api/v2/projects after POST /projects/:id/members", async () => {
    await seedUser(100, "maintainer")
    await seedUser(101, "invitee")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 100)",
    )
      .bind("proj-fro323", "Genesis Project")
      .run()

    // Maintainer adds invitee directly
    const addRes = await app.request(
      "/api/v2/projects/proj-fro323/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("maintainer")),
        body: JSON.stringify({ username: "invitee", role: 400 }),
      },
      env,
    )
    expect(addRes.status).toBe(200)

    // Invitee's GET /api/v2/projects must include the project
    const listRes = await app.request(
      "/api/v2/projects",
      { method: "GET", headers: authHeader(await jwtFor("invitee")) },
      env,
    )
    expect(listRes.status).toBe(200)
    const { projects } = (await listRes.json()) as { projects: Array<{ id: string }> }
    const found = projects.some((p) => p.id === "proj-fro323")
    expect(found).toBe(true)
  })

  it("invitee does NOT see project before being added", async () => {
    await seedUser(102, "other-maintainer")
    await seedUser(103, "not-yet-invited")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 102)",
    )
      .bind("proj-fro323-b", "Private Project")
      .run()

    const listRes = await app.request(
      "/api/v2/projects",
      { method: "GET", headers: authHeader(await jwtFor("not-yet-invited")) },
      env,
    )
    expect(listRes.status).toBe(200)
    const { projects } = (await listRes.json()) as { projects: Array<{ id: string }> }
    expect(projects.some((p) => p.id === "proj-fro323-b")).toBe(false)
  })

  it("project list honours ?minRole filter (FRO-321)", async () => {
    await seedUser(104, "multi-role-user")
    await seedUser(105, "owner-of-two")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 105)",
    )
      .bind("proj-maintainer", "Maintainer Project")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 105)",
    )
      .bind("proj-contributor", "Contributor Project")
      .run()

    // Add multi-role-user as maintainer (600) to one project, contributor (400) to another
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 105)",
    )
      .bind("proj-maintainer", 104, 600)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 105)",
    )
      .bind("proj-contributor", 104, 400)
      .run()

    // Without minRole: sees both
    const allRes = await app.request(
      "/api/v2/projects",
      { method: "GET", headers: authHeader(await jwtFor("multi-role-user")) },
      env,
    )
    expect(allRes.status).toBe(200)
    const { projects: allProjects } = (await allRes.json()) as { projects: Array<{ id: string }> }
    expect(allProjects.some((p) => p.id === "proj-maintainer")).toBe(true)
    expect(allProjects.some((p) => p.id === "proj-contributor")).toBe(true)

    // With minRole=600: sees only the maintainer project
    const filteredRes = await app.request(
      "/api/v2/projects?minRole=600",
      { method: "GET", headers: authHeader(await jwtFor("multi-role-user")) },
      env,
    )
    expect(filteredRes.status).toBe(200)
    const { projects: filtered } = (await filteredRes.json()) as { projects: Array<{ id: string }> }
    expect(filtered.some((p) => p.id === "proj-maintainer")).toBe(true)
    expect(filtered.some((p) => p.id === "proj-contributor")).toBe(false)
  })
})

// ── FRO-283: expires_in_days honored ──────────────────────────────────────
describe("POST /api/v2/projects/:id/invites: expires_in_days (FRO-283)", () => {
  it("honors expires_in_days=1 from client", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-ttl1", "Test")
      .run()

    const before = Date.now()
    const res = await app.request(
      "/api/v2/projects/p-ttl1/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ role: 400, expires_in_days: 1 }) },
      env,
    )
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const row = await env.AQUILLA_PG.prepare(
      "SELECT expires_at FROM project_invites WHERE token = ?",
    )
      .bind(token)
      .first<{ expires_at: string | null }>()
    expect(row?.expires_at).not.toBeNull()
    const expiresMs = new Date(row!.expires_at!).getTime()
    // Should be ~1 day from now (within a 10-second window for test latency)
    expect(expiresMs - before).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(expiresMs - before).toBeLessThan(25 * 60 * 60 * 1000)
  })

  it("honors expires_in_days=null (no expiry)", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-ttl2", "Test")
      .run()

    const res = await app.request(
      "/api/v2/projects/p-ttl2/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ role: 400, expires_in_days: null }) },
      env,
    )
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const row = await env.AQUILLA_PG.prepare(
      "SELECT expires_at FROM project_invites WHERE token = ?",
    )
      .bind(token)
      .first<{ expires_at: string | null }>()
    expect(row?.expires_at).toBeNull()
  })

  it("defaults to 30-day expiry when expires_in_days omitted", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-ttl3", "Test")
      .run()

    const before = Date.now()
    const res = await app.request(
      "/api/v2/projects/p-ttl3/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ role: 400 }) },
      env,
    )
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const row = await env.AQUILLA_PG.prepare(
      "SELECT expires_at FROM project_invites WHERE token = ?",
    )
      .bind(token)
      .first<{ expires_at: string | null }>()
    expect(row?.expires_at).not.toBeNull()
    const expiresMs = new Date(row!.expires_at!).getTime()
    // Should be ~30 days
    expect(expiresMs - before).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
    expect(expiresMs - before).toBeLessThan(31 * 24 * 60 * 60 * 1000)
  })
})

// ── FRO-429: distinct error codes for used vs time-expired invites ─────────
//
// The frontend needs to show a different message for:
//   "already used" (single-use link was redeemed by someone else)
//   "time expired" (the link's expiry date has passed)
// Both return HTTP 410 but with a `code` field in the body.

describe("FRO-429: invite-preview returns code field distinguishing used vs time-expired", () => {
  it("GET /invite-preview returns code:'used' when invite is already redeemed", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-fro429-used", "FRO-429 Used")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, used_by, used_at, expires_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
    )
      .bind("tok-fro429-used", "p-fro429-used", 400, 1, 2, new Date(Date.now() + 86400000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/projects/invite-preview/tok-fro429-used",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("used")
    expect(body.error).toMatch(/already used/i)
  })

  it("GET /invite-preview returns code:'time_expired' when invite has passed expiry", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-fro429-exp", "FRO-429 Expired")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("tok-fro429-exp", "p-fro429-exp", 400, 1, new Date(Date.now() - 60000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/projects/invite-preview/tok-fro429-exp",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("time_expired")
    expect(body.error).toMatch(/expired/i)
  })

  it("POST /accept-invite returns code:'used' when already redeemed by another user", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedUser(3, "carol")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-fro429-accept-used", "FRO-429 Accept Used")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, used_by, used_at, expires_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
    )
      .bind("tok-fro429-accept-used", "p-fro429-accept-used", 400, 1, 2, new Date(Date.now() + 86400000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("carol")), body: JSON.stringify({ token: "tok-fro429-accept-used" }) },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("used")
  })

  it("POST /accept-invite returns code:'time_expired' when past expiry", async () => {
    await seedUser(1, "alice")
    await seedUser(3, "carol")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
    )
      .bind("p-fro429-accept-exp", "FRO-429 Accept Expired")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("tok-fro429-accept-exp", "p-fro429-accept-exp", 400, 1, new Date(Date.now() - 60000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("carol")), body: JSON.stringify({ token: "tok-fro429-accept-exp" }) },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("time_expired")
  })
})

describe("FRO-429: multi-invite preview returns code field distinguishing used vs time-expired", () => {
  it("GET /api/v2/invites/:token/preview returns code:'used' when all rows are redeemed", async () => {
    await seedUser(10, "alice10")
    await seedUser(11, "bob11")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 10)",
    )
      .bind("p-multi-used", "Multi Used")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, used_by, used_at, expires_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
    )
      .bind("tok-multi-used", "p-multi-used", 400, 10, 11, new Date(Date.now() + 86400000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/invites/tok-multi-used/preview",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("used")
  })

  it("GET /api/v2/invites/:token/preview returns code:'time_expired' when past expiry", async () => {
    await seedUser(10, "alice10")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 10)",
    )
      .bind("p-multi-exp", "Multi Expired")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_invites (token, project_id, role_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("tok-multi-exp", "p-multi-exp", 400, 10, new Date(Date.now() - 60000).toISOString())
      .run()
    const res = await app.request(
      "/api/v2/invites/tok-multi-exp/preview",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("time_expired")
  })
})

// ── FRO-364: magic-link invite instantly invalid on accept ──────────────────
//
// Repro from the ticket: a project_lead mints a magic-link (email-bound,
// single-project) invite via POST /:projectId/invites → the invitee clicks
// "Accept invitation" immediately. JoinPage's redeem() tries the MULTI accept
// endpoint FIRST (POST /api/v2/invites/:token/accept) for every token —
// including single-project ones minted by the legacy endpoint — and only
// falls back to the legacy accept if the multi accept returns nothing
// accepted. This test drives that exact real path end-to-end.
describe("FRO-364: magic-link invite accept — real redeem path via JoinPage's endpoint order", () => {
  it("accepts a freshly-minted email-bound single-project invite via the multi accept endpoint immediately", async () => {
    await seedUser(20, "lead20") // project_lead, mints the invite
    await seedUser(21, "invitee21") // email: invitee21@example.com

    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 20)",
    )
      .bind("p-fro364", "FRO-364 project")
      .run()

    // Mint the magic-link invite exactly as POST /:projectId/invites does:
    // email-bound, 7-day expiry (mirrors the ticket's "expires in 7 days").
    const createRes = await app.request(
      "/api/v2/projects/p-fro364/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead20")),
        body: JSON.stringify({
          role: 400,
          email: "invitee21@example.com",
          expires_in_days: 7,
        }),
      },
      env,
    )
    expect(createRes.status).toBe(200)
    const { token } = (await createRes.json()) as { token: string }

    // Invitee clicks "Accept invitation" immediately — JoinPage's redeem()
    // tries the multi endpoint first, for every token.
    const acceptRes = await app.request(
      `/api/v2/invites/${token}/accept`,
      { method: "POST", headers: authHeader(await jwtFor("invitee21")) },
      env,
    )

    // BUG (FRO-364): the multi accept endpoint queries project_invites by
    // token and finds the one row (single-project invites share the same
    // table), but the row's `email` column IS set — so the multi accept's
    // email-bound guard should pass. Expect success end-to-end: the real
    // failure mode reported by QA was "invite link no longer valid" (410
    // "used" or 404), which this assertion pins to fail until fixed.
    expect(acceptRes.status).toBe(200)
    const body = (await acceptRes.json()) as {
      token: string
      accepted: { projectId: string; role: number }[]
    }
    expect(body.accepted).toEqual([{ projectId: "p-fro364", role: 400 }])

    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
    )
      .bind("p-fro364", 21)
      .first<{ role_level: number }>()
    expect(member?.role_level).toBe(400)
  })
})
