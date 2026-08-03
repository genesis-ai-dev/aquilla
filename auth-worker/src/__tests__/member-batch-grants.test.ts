import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-736: the three membership-grant endpoints accept a batch of people and
// return per-person results, without breaking the legacy single-user body.
// Grants are deliberately non-atomic — one ineligible person must not roll back
// the valid grants — and authorization is applied per target exactly as the
// single-user path enforces it.

type BatchResult = {
  results: Array<{ username: string; ok: boolean; error?: { code: string; message: string } }>
}

async function seedOrgWithMembers() {
  // alice: org owner (700). bob/carol/dave: org members. eve: org member too.
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await seedUser(3, "carol")
  await seedUser(4, "dave")
  await seedUser(5, "eve")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1), (1, 4, 400, 1), (1, 5, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Shared', 1, 1)",
  ).run()
}

async function projectRole(userId: number): Promise<number | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM project_members WHERE project_id = 'p1' AND user_id = ?",
  )
    .bind(userId)
    .first<{ role_level: number }>()
  return row ? Number(row.role_level) : null
}

describe("POST /api/v2/projects/:id/members — batch (AQU-736)", () => {
  it("grants three org members in one request; all present at requested roles", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 400 },
            { username: "carol", role: 300 },
            { username: "dave", role: 500 },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    expect(body.results).toHaveLength(3)
    expect(body.results.every((r) => r.ok)).toBe(true)
    expect(await projectRole(2)).toBe(400)
    expect(await projectRole(3)).toBe(300)
    expect(await projectRole(4)).toBe(500)
  })

  it("still accepts the legacy single-user body unchanged", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ username: "bob", role: 400 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      userId: number
      username: string
      role: { level: number; name: string; source: string }
    }
    expect(body).toMatchObject({ userId: 2, username: "bob", role: { level: 400, source: "override" } })
    expect(await projectRole(2)).toBe(400)
  })

  it("partial failure: valid grants land, unknown username reported without rollback", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 400 },
            { username: "ghost", role: 400 },
            { username: "carol", role: 400 },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    expect(body.results.map((r) => [r.username, r.ok])).toEqual([
      ["bob", true],
      ["ghost", false],
      ["carol", true],
    ])
    const ghost = body.results.find((r) => r.username === "ghost")
    expect(ghost?.error?.code).toBe("user_not_found")
    // Valid grants were not rolled back.
    expect(await projectRole(2)).toBe(400)
    expect(await projectRole(3)).toBe(400)
  })

  it("enforces authorization per person: role-above-caller, target-outranks, self-grant", async () => {
    await seedOrgWithMembers()
    // eve is only a project_lead (500) on p1 — not owner — via a direct grant.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 5, 500, 1)",
    ).run()
    // dave already sits at maintainer (600) — above eve — so eve can't modify him.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 4, 600, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("eve")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 400 }, // legit — lands
            { username: "carol", role: 600 }, // above eve's own level (500)
            { username: "dave", role: 500 }, // dave currently outranks eve (600 >= 500)
            { username: "eve", role: 300 }, // self-grant
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    const byName = Object.fromEntries(body.results.map((r) => [r.username, r]))
    expect(byName.bob.ok).toBe(true)
    expect(byName.carol).toMatchObject({ ok: false, error: { code: "role_above_caller" } })
    expect(byName.dave).toMatchObject({ ok: false, error: { code: "target_outranks_caller" } })
    expect(byName.eve).toMatchObject({ ok: false, error: { code: "self_grant" } })
    // Only the legit grant landed; dave stays where he was, carol un-added.
    expect(await projectRole(2)).toBe(400)
    expect(await projectRole(3)).toBeNull()
    expect(await projectRole(4)).toBe(600)
  })

  it("collapses duplicate usernames to a single grant without error", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 400 },
            { username: "BOB", role: 400 },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ ok: true })
    expect(await projectRole(2)).toBe(400)
  })

  it("rejects a malformed batch (empty, non-array, over cap) with 400 and no writes", async () => {
    await seedOrgWithMembers()
    const jwt = await jwtFor("alice")
    const empty = await app.request(
      "/api/v2/projects/p1/members",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ members: [] }) },
      env,
    )
    expect(empty.status).toBe(400)

    const notArray = await app.request(
      "/api/v2/projects/p1/members",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ members: "bob" }) },
      env,
    )
    expect(notArray.status).toBe(400)

    const tooMany = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          members: Array.from({ length: 101 }, (_, i) => ({ username: `u${i}`, role: 400 })),
        }),
      },
      env,
    )
    expect(tooMany.status).toBe(400)

    // No project_members rows were written by any of the rejected calls.
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = 'p1'",
    ).first<{ n: number }>()
    expect(Number(rows?.n)).toBe(0)
  })
})

describe("POST /api/v2/orgs/:id/members — batch (AQU-736)", () => {
  async function seedTwoOrgs() {
    // org 1 owner alice; org 2 owner is nobody special. bob/carol are floating
    // users we grant into org 1.
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedUser(3, "carol")
    await seedUser(6, "mallory")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 6, 600, 1)",
    ).run()
  }

  async function orgRole(userId: number): Promise<number | null> {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = ?",
    )
      .bind(userId)
      .first<{ role_level: number }>()
    return row ? Number(row.role_level) : null
  }

  it("owner batches two members; single body still works; partial + self-grant reported", async () => {
    await seedTwoOrgs()
    const res = await app.request(
      "/api/v2/orgs/1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 400 },
            { username: "ghost", role: 400 },
            { username: "alice", role: 400 },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    const byName = Object.fromEntries(body.results.map((r) => [r.username, r]))
    expect(byName.bob.ok).toBe(true)
    expect(byName.ghost).toMatchObject({ ok: false, error: { code: "user_not_found" } })
    expect(byName.alice).toMatchObject({ ok: false, error: { code: "self_grant" } })
    expect(await orgRole(2)).toBe(400)

    // Legacy single body.
    const single = await app.request(
      "/api/v2/orgs/1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ username: "carol", role: 300 }),
      },
      env,
    )
    expect(single.status).toBe(200)
    expect(await orgRole(3)).toBe(300)
  })

  it("rejects a non-owner (maintainer) with 403 for the whole call", async () => {
    await seedTwoOrgs()
    const res = await app.request(
      "/api/v2/orgs/1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("mallory")),
        body: JSON.stringify({ members: [{ username: "bob", role: 400 }] }),
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await orgRole(2)).toBeNull()
  })

  it("rejects an over-cap batch with 400", async () => {
    await seedTwoOrgs()
    const res = await app.request(
      "/api/v2/orgs/1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: Array.from({ length: 101 }, (_, i) => ({ username: `u${i}`, role: 400 })),
        }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/v2/orgs/:id/groups/:gid/members — batch (AQU-736)", () => {
  async function seedGroup() {
    await seedUser(1, "alice") // owner
    await seedUser(2, "bob") // org member
    await seedUser(3, "carol") // org member
    await seedUser(7, "outsider") // NOT an org member
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Reviewers', 1)",
    ).run()
  }

  async function inGroup(userId: number): Promise<boolean> {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 AS present FROM group_members WHERE group_id = 10 AND user_id = ?",
    )
      .bind(userId)
      .first<{ present: number }>()
    return !!row
  }

  it("adds several org members via {usernames}; single {username} still works", async () => {
    await seedGroup()
    const res = await app.request(
      "/api/v2/orgs/1/groups/10/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ usernames: ["bob", "carol"] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    expect(body.results.every((r) => r.ok)).toBe(true)
    expect(await inGroup(2)).toBe(true)
    expect(await inGroup(3)).toBe(true)
  })

  it("reports per-person failures: non-org-member and unknown username", async () => {
    await seedGroup()
    const res = await app.request(
      "/api/v2/orgs/1/groups/10/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ usernames: ["bob", "outsider", "ghost"] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as BatchResult
    const byName = Object.fromEntries(body.results.map((r) => [r.username, r]))
    expect(byName.bob.ok).toBe(true)
    expect(byName.outsider).toMatchObject({ ok: false, error: { code: "not_org_member" } })
    expect(byName.ghost).toMatchObject({ ok: false, error: { code: "user_not_found" } })
    expect(await inGroup(2)).toBe(true)
    expect(await inGroup(7)).toBe(false)
  })

  it("legacy single {username} body still adds a member", async () => {
    await seedGroup()
    const res = await app.request(
      "/api/v2/orgs/1/groups/10/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ username: "bob" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { userId: number; username: string }
    expect(body).toMatchObject({ userId: 2, username: "bob" })
    expect(await inGroup(2)).toBe(true)
  })

  it("rejects empty and over-cap batches with 400", async () => {
    await seedGroup()
    const jwt = await jwtFor("alice")
    const empty = await app.request(
      "/api/v2/orgs/1/groups/10/members",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ usernames: [] }) },
      env,
    )
    expect(empty.status).toBe(400)
    const tooMany = await app.request(
      "/api/v2/orgs/1/groups/10/members",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({ usernames: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
      },
      env,
    )
    expect(tooMany.status).toBe(400)
  })
})
