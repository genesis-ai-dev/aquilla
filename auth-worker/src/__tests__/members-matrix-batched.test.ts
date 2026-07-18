/**
 * AQU-218: Batched members-matrix endpoint.
 *
 * Verifies that GET /api/v2/orgs/:orgId/members-matrix produces per-project
 * effective-member rows IDENTICAL to what GET /api/v2/projects/:id/members
 * returns for the same fixture — i.e., the batch is a pure performance
 * optimisation, not a behaviour change.
 *
 * Fixture covers all four grant paths required by the issue spec:
 *   - org-membership role:  anna has org viewer (100) on org 1
 *   - direct override:      anna has a direct reviewer (300) on project "pa"
 *   - group grant:          anna is in "Translators" group → contributor (400) on "pa"
 *   - creator:              anna created project "pb" → owner (700)
 *
 * max-wins for anna on "pa":  group(400) > override(300) > org(100)
 *   winner = group, secondarySources = [override(300), org(100)]
 * max-wins for anna on "pb":  creator(700) > org(100)
 *   winner = creator, secondarySources = [org(100)]
 *
 * Edge: org with zero accessible projects (viewer has no grant paths on any
 * project) → matrix returns empty `projects` array without error.
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

async function seedFixture() {
  // users
  await seedUser(1, "wendi") // org owner / matrix caller
  await seedUser(2, "anna")  // subject: multi-path access on pa; creator of pb

  // org
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()

  // org members: wendi=700, anna=100 (viewer)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 100, 1)",
  ).run()

  // projects: pa created by wendi, pb created by anna — both in org 1
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 2)",
  ).run()

  // direct override: anna → reviewer (300) on pa
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 2, 300, 1)",
  ).run()

  // group grant: anna in "Translators" → contributor (400) on pa
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (5, 1, 'Translators', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id) VALUES (5, 2)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (5, 'pa', 400, 1)",
  ).run()
}

// ---------------------------------------------------------------------------
// Type helpers matching the API shape
// ---------------------------------------------------------------------------

interface ApiMember {
  userId: number
  username: string
  role: { level: number; name: string; source: string }
  secondarySources: Array<{ source: string; level: number; name: string }>
}

interface PerProjectBody {
  members: ApiMember[]
}

interface MatrixBody {
  projects: Array<{ projectId: string; members: ApiMember[] }>
}

// ---------------------------------------------------------------------------

describe("GET /api/v2/orgs/:orgId/members-matrix (AQU-218 batched endpoint)", () => {
  it("returns identical role/source/secondarySources as per-project endpoint for each project", async () => {
    await seedFixture()
    const jwt = await jwtFor("wendi")

    // --- per-project resolution (reference) ---------------------------------
    const paPp = await app.request("/api/v2/projects/pa/members", { headers: authHeader(jwt) }, env)
    expect(paPp.status).toBe(200)
    const paRef = ((await paPp.json()) as PerProjectBody).members

    const pbPp = await app.request("/api/v2/projects/pb/members", { headers: authHeader(jwt) }, env)
    expect(pbPp.status).toBe(200)
    const pbRef = ((await pbPp.json()) as PerProjectBody).members

    // --- batched matrix -----------------------------------------------------
    const matrixRes = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(jwt) }, env)
    expect(matrixRes.status).toBe(200)

    const matrixBody = (await matrixRes.json()) as MatrixBody
    const byProject = new Map(matrixBody.projects.map((p) => [p.projectId, p.members]))

    const paBatched = byProject.get("pa") ?? []
    const pbBatched = byProject.get("pb") ?? []

    // Helper: sort members by userId for stable comparison
    const sort = (ms: ApiMember[]) => [...ms].sort((a, b) => a.userId - b.userId)
    const simplify = (ms: ApiMember[]) =>
      sort(ms).map((m) => ({
        userId: m.userId,
        username: m.username,
        roleLevel: m.role.level,
        source: m.role.source,
        secondarySources: [...m.secondarySources].sort((a, b) => b.level - a.level),
      }))

    expect(simplify(paBatched)).toEqual(simplify(paRef))
    expect(simplify(pbBatched)).toEqual(simplify(pbRef))
  })

  it("anna on 'pa' wins via group (400), with direct(300) and org(100) as secondarySources", async () => {
    await seedFixture()
    const jwt = await jwtFor("wendi")

    const res = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as MatrixBody
    const pa = body.projects.find((p) => p.projectId === "pa")
    expect(pa).toBeDefined()

    const anna = pa!.members.find((m) => m.username === "anna")
    expect(anna).toBeDefined()

    // Winning path: group(400) > override(300) > org(100)
    expect(anna!.role.source).toBe("group")
    expect(anna!.role.level).toBe(400)

    // secondarySources must contain both the direct override and the org path
    const sources = anna!.secondarySources.map((s) => s.source).sort()
    expect(sources).toEqual(["org", "override"])
  })

  it("anna on 'pb' (her project) wins via creator (700), org(100) is secondary", async () => {
    await seedFixture()
    const jwt = await jwtFor("wendi")

    const res = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as MatrixBody
    const pb = body.projects.find((p) => p.projectId === "pb")
    expect(pb).toBeDefined()

    const anna = pb!.members.find((m) => m.username === "anna")
    expect(anna).toBeDefined()

    // Creator path wins (700 > 100)
    expect(anna!.role.source).toBe("creator")
    expect(anna!.role.level).toBe(700)

    // org path is secondary
    expect(anna!.secondarySources).toHaveLength(1)
    expect(anna!.secondarySources[0]).toMatchObject({ source: "org", level: 100 })
  })

  it("non-member gets 403", async () => {
    await seedFixture()
    await seedUser(9, "outsider")
    const res = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(res.status).toBe(403)
  })

  it("org with zero accessible projects → empty projects array, no error", async () => {
    // Fresh org: wendi is owner, no projects
    await seedUser(10, "solo")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (99, 'EmptyOrg', 10)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (99, 10, 700, 10)",
    ).run()

    const res = await app.request("/api/v2/orgs/99/members-matrix", { headers: authHeader(await jwtFor("solo")) }, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as MatrixBody
    expect(body.projects).toEqual([])
  })

  it("invalid orgId returns 400", async () => {
    await seedUser(1, "wendi")
    const res = await app.request("/api/v2/orgs/not-a-number/members-matrix", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(400)
  })

  it("low-role caller (anna, org viewer=100) sees only the projects the per-project endpoint also exposes to her", async () => {
    // Anna is org viewer (100) on org 1. She has a direct reviewer (300) on "pa"
    // and is creator (700) of "pb". The batched matrix called as anna should
    // return only the projects she has any effective access to, and the per-project
    // reference (called as anna) must agree on role/source for each project.
    await seedFixture()
    // AQU-485: rosterViewMinRole defaults to maintainer(600), which would 403
    // the per-project /members reference call below (anna's winning role on
    // "pa" is contributor=400, below the default floor) — that's an
    // orthogonal, deliberate visibility gate, not something this test's
    // matrix-vs-per-project EQUIVALENCE check is about. Open the roster floor
    // for this fixture's org so both endpoints are directly comparable again.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{\"rosterViewMinRole\":100}', 1, 1)",
    ).run()
    const annaJwt = await jwtFor("anna")

    // --- per-project reference (anna calling) --------------------------------
    const paPpAnna = await app.request("/api/v2/projects/pa/members", { headers: authHeader(annaJwt) }, env)
    // Anna has access to pa (contributor via group > reviewer direct > org viewer)
    expect(paPpAnna.status).toBe(200)
    const paRefAnna = ((await paPpAnna.json()) as PerProjectBody).members

    const pbPpAnna = await app.request("/api/v2/projects/pb/members", { headers: authHeader(annaJwt) }, env)
    // Anna created pb — she has owner access
    expect(pbPpAnna.status).toBe(200)
    const pbRefAnna = ((await pbPpAnna.json()) as PerProjectBody).members

    // --- batched matrix (anna calling) --------------------------------------
    const matrixRes = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(annaJwt) }, env)
    expect(matrixRes.status).toBe(200)

    const matrixBody = (await matrixRes.json()) as MatrixBody
    const byProject = new Map(matrixBody.projects.map((p) => [p.projectId, p.members]))

    const sort = (ms: ApiMember[]) => [...ms].sort((a, b) => a.userId - b.userId)
    const simplify = (ms: ApiMember[]) =>
      sort(ms).map((m) => ({
        userId: m.userId,
        username: m.username,
        roleLevel: m.role.level,
        source: m.role.source,
        secondarySources: [...m.secondarySources].sort((a, b) => b.level - a.level),
      }))

    // The batched response must match per-project for each project anna can see.
    const paBatched = byProject.get("pa") ?? []
    const pbBatched = byProject.get("pb") ?? []
    expect(simplify(paBatched)).toEqual(simplify(paRefAnna))
    expect(simplify(pbBatched)).toEqual(simplify(pbRefAnna))

    // Sanity: anna herself must appear in both project member lists.
    const annaInPa = paBatched.find((m) => m.username === "anna")
    expect(annaInPa).toBeDefined()
    // Anna's winning role on pa via group is contributor (400)
    expect(annaInPa!.role.level).toBe(400)

    const annaInPb = pbBatched.find((m) => m.username === "anna")
    expect(annaInPb).toBeDefined()
    // Anna created pb — creator wins (700)
    expect(annaInPb!.role.level).toBe(700)
  })
})
