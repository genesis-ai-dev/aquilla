import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// FRO-326: GET /api/v2/invites/mine — the invitee-side "received invites"
// surface. Email is the only recipient identity an invite carries, so the
// endpoint must return exactly the unredeemed, unexpired, email-matching
// invites — and nothing else (open links and other users' invites would be
// a privacy leak per FRO-321).

interface MineResponse {
  invites: Array<{
    token: string
    role: { level: number; name: string }
    createdBy: string
    projects: Array<{ projectId: string; projectName: string }>
  }>
}

async function seedProject(id: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(id, name, createdBy)
    .run()
}

async function seedInvite(opts: {
  token: string
  projectId: string
  email?: string | null
  expiresAt?: string | null
  usedBy?: number | null
}): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_invites
       (token, project_id, role_level, created_by, email, expires_at, used_by, used_at)
     VALUES (?, ?, 400, 1, ?, ?, ?, CASE WHEN ?::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)`,
  )
    .bind(
      opts.token,
      opts.projectId,
      opts.email ?? null,
      opts.expiresAt ?? null,
      opts.usedBy ?? null,
      opts.usedBy ?? null,
    )
    .run()
}

describe("GET /api/v2/invites/mine", () => {
  beforeEach(async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("proj-1", "Genesis", 1)
    await seedProject("proj-2", "Exodus", 1)
  })

  it("returns unredeemed, unexpired invites matching the caller's email (case-insensitive)", async () => {
    // Targeted at bob, mixed case — must match bob@example.com.
    await seedInvite({ token: "tok-bob-aaaa", projectId: "proj-1", email: "BOB@Example.com" })

    const res = await app.request(
      "/api/v2/invites/mine",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as MineResponse
    expect(body.invites).toHaveLength(1)
    expect(body.invites[0].token).toBe("tok-bob-aaaa")
    expect(body.invites[0].createdBy).toBe("alice")
    expect(body.invites[0].projects).toEqual([
      { projectId: "proj-1", projectName: "Genesis" },
    ])
  })

  it("groups multi-project rows sharing a token into one entry", async () => {
    await seedInvite({ token: "tok-multi-aa", projectId: "proj-1", email: "bob@example.com" })
    await seedInvite({ token: "tok-multi-aa", projectId: "proj-2", email: "bob@example.com" })

    const res = await app.request(
      "/api/v2/invites/mine",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    const body = (await res.json()) as MineResponse
    expect(body.invites).toHaveLength(1)
    expect(body.invites[0].projects.map((p) => p.projectName).sort()).toEqual([
      "Exodus",
      "Genesis",
    ])
  })

  it("excludes open links, other users' invites, used and expired invites", async () => {
    // Open link (no recipient identity) — never attributable to bob.
    await seedInvite({ token: "tok-open-aaaa", projectId: "proj-1", email: null })
    // Addressed to someone else — privacy per FRO-321.
    await seedInvite({ token: "tok-alice-aaa", projectId: "proj-1", email: "alice@example.com" })
    // Already redeemed.
    await seedInvite({ token: "tok-used-aaaa", projectId: "proj-1", email: "bob@example.com", usedBy: 2 })
    // Expired yesterday.
    await seedInvite({
      token: "tok-expired-a",
      projectId: "proj-1",
      email: "bob@example.com",
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    })

    const res = await app.request(
      "/api/v2/invites/mine",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    const body = (await res.json()) as MineResponse
    expect(body.invites).toEqual([])
  })

  it("requires authentication", async () => {
    const res = await app.request("/api/v2/invites/mine", {}, env)
    expect(res.status).toBe(401)
  })
})

// FRO-326 hardening: JoinPage prefers the multi accept endpoint even for
// single-project tokens, so the FRO-283 email binding (and the archived-
// project guard) must be enforced HERE, not just in the legacy accept.
describe("POST /api/v2/invites/:token/accept — email binding + archived guard", () => {
  beforeEach(async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("proj-1", "Genesis", 1)
  })

  it("rejects an email-bound invite redeemed by a different account", async () => {
    await seedInvite({ token: "tok-bound-aaa", projectId: "proj-1", email: "someoneelse@example.com" })
    const res = await app.request(
      "/api/v2/invites/tok-bound-aaa/accept",
      { method: "POST", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(403)
    const members = await env.AQUILLA_PG.prepare(
      "SELECT user_id FROM project_members WHERE project_id = 'proj-1'",
    ).all()
    expect(members.results).toHaveLength(0)
  })

  it("accepts an email-bound invite for the matching account (case-insensitive)", async () => {
    await seedInvite({ token: "tok-bound-bbb", projectId: "proj-1", email: "BOB@Example.com" })
    const res = await app.request(
      "/api/v2/invites/tok-bound-bbb/accept",
      { method: "POST", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: Array<{ projectId: string }> }
    expect(body.accepted.map((a) => a.projectId)).toEqual(["proj-1"])
  })

  it("refuses to join an archived project, with an honest reason", async () => {
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = 'proj-1'",
    ).run()
    await seedInvite({ token: "tok-arch-aaaa", projectId: "proj-1", email: null })
    const res = await app.request(
      "/api/v2/invites/tok-arch-aaaa/accept",
      { method: "POST", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/archived/i)
  })
})
