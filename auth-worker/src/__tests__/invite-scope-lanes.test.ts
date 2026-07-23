// AQU-528: language-scoped invite links (Crowdin-style auto-grant-on-join).
//
// A share-link invite may carry lane (target-language) scopes; redeeming it as
// a NEW member both grants the baked-in role AND auto-applies those lanes as
// kind='lane' project_member_scopes, so the joiner can only translate the
// languages the link was minted for. These tests exercise the seam end-to-end
// over the real HTTP API (mint → preview → accept → resulting scopes), plus the
// regression guards that unscoped invites and existing members are untouched.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProject(id: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(id, `Project ${id}`, createdBy)
    .run()
}

async function laneScopesFor(projectId: string, userId: number): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT value FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane' ORDER BY value",
  )
    .bind(projectId, userId)
    .all<{ value: string }>()
  return (rows.results ?? []).map((r) => r.value)
}

describe("AQU-528 single-project language-scoped invite", () => {
  it("mints an invite bound to lanes and returns them", async () => {
    await seedUser(1, "alice")
    await seedProject("p1", 1)

    const res = await app.request(
      "/api/v2/projects/p1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ role: 400, scopeLanes: ["es"] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; scopeLanes?: string[] }
    expect(body.scopeLanes).toEqual(["es"])

    const stored = await env.AQUILLA_PG.prepare(
      "SELECT scope_lanes FROM project_invites WHERE token = ?",
    )
      .bind(body.token)
      .first<{ scope_lanes: string | null }>()
    expect(JSON.parse(stored?.scope_lanes ?? "null")).toEqual(["es"])
  })

  it("auto-grants exactly the invite's lanes to a new joiner on accept", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("p1", 1)

    const created = await app.request(
      "/api/v2/projects/p1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ role: 400, scopeLanes: ["es"] }),
      },
      env,
    )
    const { token } = (await created.json()) as { token: string }

    const accepted = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token }),
      },
      env,
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ projectId: "p1", role: 400 })

    // Joiner is a contributor AND scoped to the 'es' lane only.
    expect(await laneScopesFor("p1", 2)).toEqual(["es"])

    // And the scope is visible via the real read path the sync-token/UI use.
    const scopesRes = await app.request(
      "/api/v2/projects/p1/members/2/scopes",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(scopesRes.status).toBe(200)
    expect(await scopesRes.json()).toEqual({ scopes: [{ kind: "lane", value: "es" }] })
  })

  it("records the inviter as the scope's granted-by (auditable)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("p1", 1)
    const created = await app.request(
      "/api/v2/projects/p1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ scopeLanes: ["es"] }),
      },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: JSON.stringify({ token }) },
      env,
    )
    const row = await env.AQUILLA_PG.prepare(
      "SELECT created_by FROM project_member_scopes WHERE project_id = 'p1' AND user_id = 2 AND kind = 'lane'",
    ).first<{ created_by: string }>()
    expect(row?.created_by).toBe("1")
  })

  it("surfaces scopeLanes in the public invite preview", async () => {
    await seedUser(1, "alice")
    await seedProject("p1", 1)
    const created = await app.request(
      "/api/v2/projects/p1/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ scopeLanes: ["fr"] }),
      },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ scopeLanes: ["fr"] })
  })
})

describe("AQU-528 regression: existing invites unchanged", () => {
  it("an unscoped invite grants NO lane scopes on accept", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("p1", 1)
    const created = await app.request(
      "/api/v2/projects/p1/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ role: 400 }) },
      env,
    )
    const { token, scopeLanes } = (await created.json()) as { token: string; scopeLanes?: string[] }
    // Omitted scopeLanes must not appear in the response at all.
    expect(scopeLanes).toBeUndefined()

    await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: JSON.stringify({ token }) },
      env,
    )
    // No rows = unscoped = writes across every lane (today's behavior).
    expect(await laneScopesFor("p1", 2)).toEqual([])
  })

  it("does NOT narrow an already-existing (unscoped) member", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("p1", 1)
    // Bob is already an unscoped contributor.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 2, 400, 1)",
    ).run()
    const created = await app.request(
      "/api/v2/projects/p1/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ scopeLanes: ["es"] }) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const accepted = await app.request(
      "/api/v2/projects/accept-invite",
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: JSON.stringify({ token }) },
      env,
    )
    expect(accepted.status).toBe(200)
    // Bob stays unscoped — a lane-scoped link never silently restricts an
    // existing broader member; it only auto-grants to brand-new joiners.
    expect(await laneScopesFor("p1", 2)).toEqual([])
  })

  it("is idempotent when the same joiner re-accepts", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("p1", 1)
    const created = await app.request(
      "/api/v2/projects/p1/invites",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ scopeLanes: ["es"] }) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const body = JSON.stringify({ token })
    await app.request("/api/v2/projects/accept-invite", { method: "POST", headers: authHeader(await jwtFor("bob")), body }, env)
    const second = await app.request("/api/v2/projects/accept-invite", { method: "POST", headers: authHeader(await jwtFor("bob")), body }, env)
    expect(second.status).toBe(200)
    expect(await laneScopesFor("p1", 2)).toEqual(["es"])
  })
})

describe("AQU-528 multi-project language-scoped invite", () => {
  it("auto-grants the same lanes across every project sharing the token", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("pa", 1)
    await seedProject("pb", 1)

    const created = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ projectIds: ["pa", "pb"], roleLevel: 400, scopeLanes: ["es", "fr"] }),
      },
      env,
    )
    expect(created.status).toBe(200)
    const { token, scopeLanes } = (await created.json()) as { token: string; scopeLanes?: string[] }
    expect(scopeLanes).toEqual(["es", "fr"])

    const preview = await app.request(`/api/v2/invites/${token}/preview`, {}, env)
    expect(await preview.json()).toMatchObject({ scopeLanes: ["es", "fr"] })

    const accepted = await app.request(
      `/api/v2/invites/${token}/accept`,
      { method: "POST", headers: authHeader(await jwtFor("bob")), body: "{}" },
      env,
    )
    expect(accepted.status).toBe(200)

    expect(await laneScopesFor("pa", 2)).toEqual(["es", "fr"])
    expect(await laneScopesFor("pb", 2)).toEqual(["es", "fr"])
  })

  it("unscoped multi-invite grants no lane scopes (regression)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedProject("pa", 1)
    const created = await app.request(
      "/api/v2/invites/multi",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ projectIds: ["pa"] }) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    await app.request(`/api/v2/invites/${token}/accept`, { method: "POST", headers: authHeader(await jwtFor("bob")), body: "{}" }, env)
    expect(await laneScopesFor("pa", 2)).toEqual([])
  })
})
