/**
 * AQU-2321 — POST /api/v2/orgs/:orgId/access/removal-preview, the Remove dry
 * run, and the role-change cap behind the Places lens's role dropdown.
 *
 * The Remove dialog lists what a person loses and what they keep, then
 * removes through the existing routes. If the dry run said "loses" where the
 * resolver keeps them in (or the reverse), the confirmation would lie about
 * the one thing it exists to say. So every case here checks the dry run
 * against the route's real effect on GET /orgs/:id/access.
 *
 * Fixture (helpers/access-fixture.ts) plus team 3 "fixture/reviewers"
 * attached at Reviewer to six projects q1..q6, and rhea (no org row) on that
 * team with a direct Reviewer row on q1 dated 2026-03-04.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { FIXTURE_ORG_ID, FIXTURE_USERS, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

const RHEA = 20
const Q = ["q1", "q2", "q3", "q4", "q5", "q6"]

interface Kept { project: { id: string; name: string }; roleBefore: number; after: { roleLevel: number; source: string }; grant: { type: string; id: string } | null; grantedAt: string | null; removable: boolean }
interface Preview {
  invite: boolean
  removes: { grant: { type: string; id: string }; roleLevel: number | null }[]
  loses: { type: string; id: string; name: string }[]
  keeps: Kept[]
  leavesTeams: { id: string }[]
  guest: { before: boolean; after: boolean }
}
type Person = { userId: string } | { inviteId: string }
const who = (u: FixtureUser | number): Person => ({ userId: String(typeof u === "number" ? u : FIXTURE_USERS[u]) })

async function removal(viewer: FixtureUser, body: { person: Person; grants?: { type: string; id: string }[] }, orgId = FIXTURE_ORG_ID) {
  const res = await app.request(
    `/api/v2/orgs/${orgId}/access/removal-preview`,
    { method: "POST", headers: { ...authHeader(await jwtFor(viewer)), "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
  return { status: res.status, body: (await res.json()) as { preview?: Preview; error?: string; code?: string; cap?: number | null } }
}

async function call(viewer: FixtureUser, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    { method, headers: { ...authHeader(await jwtFor(viewer)), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
    env,
  )
}

async function roster(viewer: FixtureUser = "owner") {
  const res = await call(viewer, "GET", `/api/v2/orgs/${FIXTURE_ORG_ID}/access`)
  return (await res.json()) as {
    people: { userId: string; grants: { scopePath: { type: string; id: string }[] }[] }[]
    tree: Node[]
  }
}
interface Node { scope: { type: string; id: string }; children: Node[]; directGrantees: { userId: string; roleLevel: number }[]; inherited: { userId?: string; roleLevel: number; from: { type: string; id: string } }[] }
const flat = (n: Node): Node[] => [n, ...n.children.flatMap(flat)]

beforeEach(async () => {
  await seedAccessFixture()
  await seedUser(RHEA, "rhea")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ${Q.map((id) => `('${id}', 'Book ${id.toUpperCase()}', ${FIXTURE_ORG_ID}, 1)`).join(", ")}`,
  ).run()
  await env.AQUILLA_PG.prepare(`INSERT INTO groups (id, org_id, name, created_by) VALUES (3, ${FIXTURE_ORG_ID}, 'fixture/reviewers', 1)`).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES ${Q.map((id) => `(3, '${id}', 300, 1)`).join(", ")}`,
  ).run()
  await env.AQUILLA_PG.prepare(`INSERT INTO group_members (group_id, user_id, added_by) VALUES (3, ${RHEA}, 1)`).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at) VALUES ('q1', ${RHEA}, 300, 1, '2026-03-04T00:00:00Z')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, position) VALUES ('lanefr01', 'p1', 'target', 'French', 'French', 0)`,
  ).run()
})

describe("AQU-2321 Remove dry run", () => {
  it("AC1/AC2: leaving a team loses its other projects and keeps the one a direct grant still opens; the routes agree", async () => {
    const { status, body } = await removal("owner", { person: who(RHEA), grants: [{ type: "team", id: "3" }] })
    expect(status).toBe(200)
    const p = body.preview as Preview
    expect(p.loses.map((s) => s.id).sort()).toEqual(["q2", "q3", "q4", "q5", "q6"])
    expect(p.keeps).toEqual([
      {
        project: { type: "project", id: "q1", name: "Book Q1" },
        roleBefore: 300,
        after: expect.objectContaining({ roleLevel: 300, source: "direct" }),
        grant: { type: "project", id: "q1" },
        grantedAt: "2026-03-04T00:00:00.000Z",
        removable: true,
      },
    ])
    expect(p.guest).toEqual({ before: true, after: true })

    // Confirm without the checkbox: the team route alone. Rhea reaches q1 only.
    expect((await call("owner", "DELETE", `/api/v2/orgs/${FIXTURE_ORG_ID}/groups/3/members/${RHEA}`)).status).toBe(200)
    const after = await roster()
    const rhea = after.people.find((x) => x.userId === String(RHEA))
    expect(rhea?.grants.map((g) => g.scopePath[g.scopePath.length - 1].id)).toEqual(["q1"])

    // With the checkbox: the kept grant too. Rhea (a guest) leaves the roster.
    expect((await call("owner", "DELETE", `/api/v2/projects/q1/members/${RHEA}`)).status).toBe(200)
    expect((await roster()).people.some((x) => x.userId === String(RHEA))).toBe(false)
  })

  it("removing both grants keeps nothing; removing a direct row under a higher team role keeps the team's role, not a demotion", async () => {
    const both = await removal("owner", { person: who(RHEA), grants: [{ type: "team", id: "3" }, { type: "project", id: "q1" }] })
    expect(both.body.preview?.keeps).toEqual([])
    expect(both.body.preview?.loses).toHaveLength(6)

    // direct_below: direct Reviewer on p1 below the team's Contributor. Dropping the row keeps Contributor via the team.
    const direct = await removal("owner", { person: who("direct_below"), grants: [{ type: "project", id: "p1" }] })
    expect(direct.body.preview?.loses).toEqual([])
    expect(direct.body.preview?.keeps).toEqual([
      expect.objectContaining({ project: expect.objectContaining({ id: "p1" }), roleBefore: 400, after: expect.objectContaining({ roleLevel: 400, source: "team" }), grant: { type: "team", id: "1" } }),
    ])
  })

  it("an org removal also takes their teams, as the route does", async () => {
    const { body } = await removal("owner", { person: who("team_only"), grants: [{ type: "org", id: "1" }] })
    expect(body.preview?.leavesTeams.map((t) => t.id)).toEqual(["1"])
    expect(body.preview?.loses.map((s) => s.id).sort()).toEqual(["p1", "p2"])
    expect(body.preview?.guest).toEqual({ before: false, after: true })
  })

  it("cancelling an invite lists the place it would have opened and keeps nothing", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at)
       VALUES ('inv-x', 'p1', 300, 1, 'x@example.com', now() + interval '3 days')`,
    ).run()
    const { status, body } = await removal("owner", { person: { inviteId: "invite:project:p1:inv-x" } })
    expect(status).toBe(200)
    expect(body.preview).toMatchObject({ invite: true, keeps: [], loses: [{ type: "project", id: "p1" }] })
  })

  it.each<[string, FixtureUser, Person, { type: string; id: string }, number, string, RegExp]>([
    ["a Project lead cannot remove project members", "org_lead", who("org_contrib"), { type: "project", id: "p3" }, 403, "maintainer_on_project", /Maintainer or above.*your role there: Project lead/],
    ["only an Owner removes from the organization", "maintainer", who("team_only"), { type: "org", id: "1" }, 403, "owner_only", /only an Owner/],
    ["a grant they do not hold", "owner", who("team_only"), { type: "project", id: "p3" }, 409, "not_held", /hold no grant/],
  ])("refuses: %s", async (_why, viewer, person, grant, status, code, message) => {
    // org_lead and org_contrib hold direct rows on p3 for the first case.
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p3', 3, 500, 1), ('p3', 4, 300, 1)").run()
    const { status: got, body } = await removal(viewer, { person, grants: [grant] })
    expect(got).toBe(status)
    expect(body.code).toBe(code)
    expect(body.error).toMatch(message)
  })

  it("a viewer learns nothing about places, people, invites or orgs their lenses do not show: one identical refusal", async () => {
    // direct_above leads p1 (direct 600) and sees only fixture/translators › p1.
    // Removing the place gate, the person gate, the invite gate or the org gate makes one of these differ.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at)
       VALUES ('inv-hidden', 'p2', 300, 1, 'h@example.com', now() + interval '3 days')`,
    ).run()
    const p1 = { type: "project", id: "p1" }
    const answers = await Promise.all([
      removal("direct_above", { person: who("direct_below"), grants: [{ type: "project", id: "p2" }] }), // hidden place
      removal("direct_above", { person: who("direct_below"), grants: [{ type: "org", id: "1" }] }), // org they cannot see
      removal("direct_above", { person: who("external"), grants: [p1] }), // person only on p2
      removal("direct_above", { person: who("personal"), grants: [p1] }), // person in another org
      removal("direct_above", { person: { userId: "999999" }, grants: [p1] }), // no such person
      removal("direct_above", { person: { inviteId: "invite:project:p2:inv-hidden" } }), // invite on a hidden project
      removal("direct_above", { person: who("direct_below"), grants: [p1] }, 2), // foreign org
      removal("direct_above", { person: who("direct_below"), grants: [p1] }, 999999), // no such org
    ])
    for (const answer of answers) expect(answer).toEqual({ status: 403, body: { error: "no access to this roster" } })
    const ok = await removal("direct_above", { person: who("direct_below"), grants: [p1] })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).not.toContain("Fixture Org")
  })
})

describe("AQU-2321 Change role through the existing routes", () => {
  it("AC3: a direct Reviewer changed to Contributor is Contributor on the project and on each of its languages", async () => {
    const res = await call("owner", "POST", "/api/v2/projects/p1/members", { username: "direct_below", role: 400 })
    expect(res.status).toBe(200)
    const nodes = (await roster()).tree.flatMap(flat)
    const p1 = nodes.find((n) => n.scope.type === "project" && n.scope.id === "p1")
    expect(p1?.directGrantees).toContainEqual(expect.objectContaining({ userId: "6", roleLevel: 400 }))
    const french = nodes.find((n) => n.scope.type === "lane" && n.scope.id === "lanefr01")
    expect(french?.inherited).toContainEqual(expect.objectContaining({ userId: "6", roleLevel: 400, from: expect.objectContaining({ type: "project", id: "p1" }) }))
  })

  it("AC5: a forged request from a Project lead for Maintainer is refused, naming the cap", async () => {
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p3', 3, 500, 1), ('p3', 4, 300, 1)").run()
    const res = await call("org_lead", "POST", "/api/v2/projects/p3/members", { username: "org_contrib", role: 600 })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/project_lead \(500\)/)
  })
})
