/**
 * AQU-2322 — lanes as places on the access page.
 *
 * A lane grant is one project_member_lane_roles row, written additively:
 * giving Lucía Quechua must never take Spanish away, and it must never write
 * the restrictive project_member_scopes table (with LANE_READ_WALL off that
 * table still limits writes to its lanes). The access page draws someone whose
 * only way into a project is lane grants as those lanes ("Contributor ·
 * Spanish"), on the lane and on the project, and counts them once.
 *
 * Fixture (helpers/access-fixture.ts) plus project Alpha (p1) with two target
 * lanes, Spanish and Quechua, and Beta (p2) with one. Lucía (12) and Marta
 * (13) are guests: no org row, a Reviewer row on Beta, so the lenses list them.
 */
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { getOrgPortfolios } from "../services/org-permissions"
import type { Env } from "../types"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { FIXTURE_ORG_ID, seedAccessFixture } from "./helpers/access-fixture"

const LUCIA = "12"
const SPANISH = "lanees01"
const QUECHUA = "lanequ01"
const BETA_LANE = "laneb201"

interface Grantee { userId: string; displayName: string; roleLevel: number; isGuest?: boolean; lanes?: { id: string; name: string; roleLevel: number }[] }
interface Node {
  scope: { type: string; id: string; name: string }
  children: Node[]
  directGrantees: Grantee[]
  inherited: { kind: string; userId?: string; displayName?: string; roleLevel: number; from: { type: string; id: string } }[]
}
interface Payload {
  tree: Node[]
  people: { userId: string; isGuest: boolean; grants: { roleLevel: number | null; scopePath: { type: "org" | "team" | "project" | "lane"; id: string; name: string }[]; origin: { kind: "direct" } }[] }[]
}

const run = (sql: string) => env.AQUILLA_PG.prepare(sql).run()
/** A Contributor has a Places lens only where the org lists its rosters to Contributors (default: Maintainer). */
const rosterOpenToContributors = () =>
  run(`INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{"rosterViewMinRole":400,"assignmentMinRole":400}', 1, 1)`)
const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]
const place = (p: Payload, type: string, id: string) => p.tree.flatMap(flatten).find((n) => n.scope.type === type && n.scope.id === id)

async function access(viewer: string): Promise<Payload> {
  const res = await app.request(`/api/v2/orgs/${FIXTURE_ORG_ID}/access`, { headers: authHeader(await jwtFor(viewer)) }, env)
  expect(res.status).toBe(200)
  return (await res.json()) as Payload
}

async function call(viewer: string, method: "PUT" | "DELETE", path: string, body: object, orgId = FIXTURE_ORG_ID) {
  const res = await app.request(`/api/v2/orgs/${orgId}/access/${path}`, { method, headers: authHeader(await jwtFor(viewer)), body: JSON.stringify(body) }, env)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const grantLane = (viewer: string, laneId: string, userId: string, roleLevel: number, orgId?: number) =>
  call(viewer, "PUT", "lane-grant", { laneId, userId, roleLevel }, orgId)
const removeLane = (viewer: string, laneId: string, userId: string) => call(viewer, "DELETE", "lane-grant", { laneId, userId })

async function post(viewer: string, path: string, body: object) {
  const res = await app.request(`/api/v2/orgs/${FIXTURE_ORG_ID}/access/${path}`, { method: "POST", headers: authHeader(await jwtFor(viewer)), body: JSON.stringify(body) }, env)
  return { status: res.status, body: (await res.json()) as { preview?: Record<string, unknown>; code?: string } }
}

async function laneRows(userId: string, projectId = "p1") {
  const { results } = await env.AQUILLA_PG.prepare(
    "SELECT lane, role_level FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? ORDER BY lane",
  ).bind(projectId, userId).all<{ lane: string; role_level: number }>()
  return (results ?? []).map((r) => [r.lane, Number(r.role_level)])
}
async function scopeRows(userId: string) {
  const { results } = await env.AQUILLA_PG.prepare("SELECT value FROM project_member_scopes WHERE project_id = 'p1' AND user_id = ?").bind(userId).all()
  return results ?? []
}
async function member(userId: string, projectId = "p1") {
  return env.AQUILLA_PG.prepare("SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, userId).first<{ role_level: number }>()
}

beforeEach(async () => {
  await seedAccessFixture()
  await seedUser(12, "lucia")
  await seedUser(13, "marta")
  await run(
    `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position) VALUES
       ('${SPANISH}', 'p1', 'target', 'Spanish', 'Spanish', 'es', 0),
       ('${QUECHUA}', 'p1', 'target', 'Quechua', 'Quechua', 'qu', 1),
       ('${BETA_LANE}', 'p2', 'target', 'French', 'French', 'fr', 0)`,
  )
  await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p2', 12, 300, 1), ('p2', 13, 300, 1)")
})

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("AQU-2322 lane grants on the Places and People lenses", () => {
  it("AC1/AC2: Lucía's Spanish grant is granted on Spanish, absent from Quechua, and one lane-named row on the project", async () => {
    expect((await grantLane("owner", SPANISH, LUCIA, 400)).status).toBe(200)
    env.LANE_READ_WALL = "1"
    const body = await access("owner")

    const spanish = place(body, "lane", SPANISH)
    expect(spanish?.directGrantees).toEqual([expect.objectContaining({ userId: LUCIA, roleLevel: 400, isGuest: true })])
    // Not also "via project": her project row is how the lane grant opens the project, not a project grant.
    expect(spanish?.inherited.some((r) => r.userId === LUCIA)).toBe(false)

    const quechua = place(body, "lane", QUECHUA)
    expect(quechua?.directGrantees).toEqual([])
    // Project-level people who open Quechua under the wall: the creator and direct_above (Maintainer).
    const viaProject = quechua?.inherited.filter((r) => r.from.type === "project").map((r) => r.displayName).sort()
    expect(viaProject).toEqual(["direct_above", "owner"])
    expect(quechua?.inherited.some((r) => r.userId === LUCIA)).toBe(false)

    const alpha = place(body, "project", "p1")
    const rows = alpha?.directGrantees.filter((g) => g.userId === LUCIA) ?? []
    expect(rows).toEqual([expect.objectContaining({ roleLevel: 400, isGuest: true, lanes: [{ id: SPANISH, name: "Spanish", roleLevel: 400 }] })])
  })

  it("project-level people's own lane rows are not lane grants, so Quechua lists no one as granted there", async () => {
    // An unscoped Contributor holds one row per lane: the planner's bookkeeping, not a narrowing.
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 4, 400, 1)")
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 4, '${SPANISH}', 400), ('p1', 4, '${QUECHUA}', 400)`)
    const body = await access("owner")
    expect(place(body, "lane", QUECHUA)?.directGrantees).toEqual([])
    expect(place(body, "lane", QUECHUA)?.inherited).toContainEqual(expect.objectContaining({ userId: "4", from: expect.objectContaining({ type: "project" }) }))
    expect(place(body, "project", "p1")?.directGrantees.find((g) => g.userId === "4")?.lanes).toBeUndefined()
    // A raise on one lane above their project role is a lane grant.
    await run(`UPDATE project_members SET role_level = 300 WHERE project_id = 'p1' AND user_id = 4`)
    await run(`UPDATE project_member_lane_roles SET role_level = 300 WHERE project_id = 'p1' AND user_id = 4 AND lane = '${QUECHUA}'`)
    const raised = await access("owner")
    expect(place(raised, "lane", SPANISH)?.directGrantees.map((g) => g.userId)).toEqual(["4"])
    expect(place(raised, "lane", QUECHUA)?.directGrantees).toEqual([])
  })

  it("AC5: a lane grant made through Give access reaches '1 lane' on the People lens", async () => {
    // org_contrib: an org Contributor, which opens no project on its own.
    expect((await grantLane("owner", SPANISH, "4", 400)).body).toMatchObject({ granted: { newMembership: true } })
    const body = await access("owner")
    const person = body.people.find((p) => p.userId === "4")!
    expect(person.grants.some((g) => g.scopePath.at(-1)?.type === "project")).toBe(false)
    // The People lens reads this as "1 lane" (src/lib/access/people-lens.test.ts pins that reading).
    expect(person.grants.filter((g) => (g.roleLevel ?? 0) > 0 && g.scopePath.at(-1)?.type !== "org").map((g) => g.scopePath.map((s) => s.name))).toEqual([["Fixture Org", "Alpha", "Spanish"]])
    expect(place(body, "lane", SPANISH)?.directGrantees.map((g) => g.userId)).toContain("4")
  })

  it("AC4: with the wall on, Lucía's own tree lists only Spanish under Alpha; with it off, both lanes", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    await rosterOpenToContributors()
    env.LANE_READ_WALL = "1"
    expect(place(await access("lucia"), "project", "p1")?.children.map((c) => c.scope.name)).toEqual(["Spanish"])
    env.LANE_READ_WALL = undefined
    expect(place(await access("lucia"), "project", "p1")?.children.map((c) => c.scope.name)).toEqual(["Spanish", "Quechua"])
  })

  it("AC4 regression: the additive grant reads exactly like the lane-scoped add from before this slice, flag on and off", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    // Marta goes through the route slice 3 used: POST /projects/:p/members with scopeLanes.
    const before = await app.request(
      "/api/v2/projects/p1/members",
      { method: "POST", headers: authHeader(await jwtFor("owner")), body: JSON.stringify({ username: "marta", role: 400, scopeLanes: [SPANISH] }) },
      env,
    )
    expect(before.status).toBe(200)
    const lanesFor = async (userId: number) => {
      const rows = await getOrgPortfolios(env as unknown as Env, [FIXTURE_ORG_ID], { userId, isAdmin: false })
      return (rows.find((r) => r.id === "p1")?.lanes ?? []).map((l) => l.lane).sort()
    }
    env.LANE_READ_WALL = undefined
    expect(await lanesFor(12)).toEqual(await lanesFor(13))
    expect(await lanesFor(12)).toEqual(["es", "qu"])
    env.LANE_READ_WALL = "1"
    expect(await lanesFor(12)).toEqual(await lanesFor(13))
    expect(await lanesFor(12)).toEqual(["es"])
  })
})

describe("AQU-2322 PUT/DELETE /orgs/:id/access/lane-grant", () => {
  it("adds lane B and leaves lane A, the membership and the scopes table untouched", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    expect(await member(LUCIA)).toEqual({ role_level: 400 })
    const second = await grantLane("owner", QUECHUA, LUCIA, 300)
    expect(second.body).toMatchObject({ granted: { newMembership: false, roleLevel: 300 } })
    expect(await laneRows(LUCIA)).toEqual([[SPANISH, 400], [QUECHUA, 300]])
    expect(await member(LUCIA)).toEqual({ role_level: 400 })
    expect(await scopeRows(LUCIA)).toEqual([])
  })

  it("gives someone already on the project one more lane without narrowing them (was 409 lane_needs_staffing)", async () => {
    // direct_below: direct Reviewer + team Contributor on Alpha, rows on both lanes.
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 6, '${SPANISH}', 400), ('p1', 6, '${QUECHUA}', 400)`)
    const preview = await post("owner", "preview", { place: { type: "lane", id: SPANISH }, roleLevel: 100, person: { userId: "6" } })
    expect(preview.status).toBe(200)
    // It overwrites their Spanish row, so it names that row; nothing else moves.
    expect(preview.body.preview).toMatchObject({ changes: [], replaces: 400, redundant: false, lane: { wallOn: false, siblingsClosed: false } })
    expect((await grantLane("owner", SPANISH, "6", 100)).status).toBe(200)
    expect(await laneRows("6")).toEqual([[SPANISH, 100], [QUECHUA, 400]])
    expect(await member("6")).toEqual({ role_level: 300 })
  })

  it("refuses a role a lane does not carry, and a viewer below Project lead, and writes nothing", async () => {
    const lead = await grantLane("owner", SPANISH, LUCIA, 500)
    expect(lead).toMatchObject({ status: 400, body: { code: "role_not_offered" } })
    // org_lead as a direct Contributor on Alpha sees its roster and lanes, but may not grant there.
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 400, 1)")
    await rosterOpenToContributors()
    const contributor = await grantLane("org_lead", SPANISH, "6", 300)
    expect(contributor).toMatchObject({ status: 403, body: { code: "lead_only" } })
    expect(await laneRows(LUCIA)).toEqual([])
    expect(await member(LUCIA)).toBeNull()
  })

  it("one identical 403 for every lane, person or org outside this viewer's lenses, on both verbs", async () => {
    // org_lead leads Alpha and holds only Spanish: with the wall on, Quechua is not on their lens.
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 500, 1)")
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 3, '${SPANISH}', 500)`)
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 4, 400, 1)")
    env.LANE_READ_WALL = "1"
    const answers = await Promise.all([
      grantLane("org_lead", QUECHUA, "4", 300), // a lane behind the read wall
      grantLane("org_lead", BETA_LANE, "4", 300), // a lane on a project they cannot see
      grantLane("org_lead", "no-such-lane", "4", 300),
      grantLane("org_lead", SPANISH, LUCIA, 300), // a person only on Beta
      grantLane("org_lead", SPANISH, "999999", 300),
      grantLane("org_lead", SPANISH, "4", 300, 2), // another org
      removeLane("org_lead", QUECHUA, "4"),
      removeLane("org_lead", SPANISH, LUCIA),
    ])
    for (const answer of answers) expect(answer).toEqual({ status: 403, body: { error: "no access to this roster" } })
    // The same lead, at their own lane, for a person on their lens, is answered.
    expect((await grantLane("org_lead", SPANISH, "4", 300)).status).toBe(200)
  })

  it("the dry run states the lane: sibling lanes stay closed with the wall on, are not restricted yet with it off", async () => {
    const ask = () => post("owner", "preview", { place: { type: "lane", id: SPANISH }, roleLevel: 400, person: { userId: LUCIA } })
    const off = await ask()
    expect(off.body.preview).toMatchObject({
      placePath: [expect.anything(), expect.objectContaining({ name: "Alpha" }), expect.objectContaining({ name: "Spanish" })],
      here: { before: null, after: { roleLevel: 400, source: "lane" } },
      changes: [{ project: expect.objectContaining({ id: "p1" }), before: null, after: expect.objectContaining({ roleLevel: 400 }) }],
      lane: { wallOn: false, siblingsClosed: true },
    })
    env.LANE_READ_WALL = "1"
    expect((await ask()).body.preview).toMatchObject({ lane: { wallOn: true, siblingsClosed: true } })
  })

  it("a walled Project lead's dry run never counts a lane their lens hides", async () => {
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 500, 1)")
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 3, '${SPANISH}', 500)`)
    env.LANE_READ_WALL = "1"
    const { body } = await post("org_lead", "preview", { place: { type: "lane", id: SPANISH }, roleLevel: 400, person: { userId: "6" } })
    expect(body.preview).toMatchObject({ lane: { wallOn: true, siblingsClosed: false } })
  })
})

describe("AQU-2322 removing a lane grant", () => {
  it("the last lane of a lane-only member also ends the membership; the dry run says so and the write does it", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    const { body } = await post("owner", "removal-preview", { person: { userId: LUCIA }, grants: [{ type: "lane", id: SPANISH }] })
    expect(body.preview).toMatchObject({
      removes: [{ grant: { type: "lane", id: SPANISH }, roleLevel: 400 }, { grant: { type: "project", id: "p1" }, withLastLane: true }],
      loses: [expect.objectContaining({ id: "p1" })],
      lanes: [{ lane: expect.objectContaining({ name: "Spanish" }), before: 400, after: null }],
    })
    expect(await removeLane("owner", SPANISH, LUCIA)).toEqual({ status: 200, body: { removed: true, endedMembership: true } })
    expect(await member(LUCIA)).toBeNull()
    expect(await laneRows(LUCIA)).toEqual([])
  })

  it("a Project lead removes one of two lanes, but not the last one: that needs the project's Maintainer rule", async () => {
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 500, 1)")
    await grantLane("owner", SPANISH, LUCIA, 400)
    await grantLane("owner", QUECHUA, LUCIA, 400)
    // Both lanes: a whole-project reader now; take Quechua off again.
    const one = await post("org_lead", "removal-preview", { person: { userId: LUCIA }, grants: [{ type: "lane", id: QUECHUA }] })
    // Wall off: the membership still opens Quechua, and the preview says so.
    expect(one.body.preview).toMatchObject({ loses: [], lanes: [{ before: 400, after: 400 }], wallOn: false })
    expect((await removeLane("org_lead", QUECHUA, LUCIA)).body).toEqual({ removed: true, endedMembership: false })
    expect(await laneRows(LUCIA)).toEqual([[SPANISH, 400]])
    const last = await removeLane("org_lead", SPANISH, LUCIA)
    expect(last).toMatchObject({ status: 403, body: { code: "maintainer_on_project" } })
    expect(await laneRows(LUCIA)).toEqual([[SPANISH, 400]])
  })

  it("with the wall on, the removed lane closes even though the membership stays", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    await grantLane("owner", QUECHUA, LUCIA, 400)
    env.LANE_READ_WALL = "1"
    const { body } = await post("owner", "removal-preview", { person: { userId: LUCIA }, grants: [{ type: "lane", id: QUECHUA }] })
    expect(body.preview).toMatchObject({ loses: [], lanes: [{ before: 400, after: null }], wallOn: true })
  })

  it("a lane row with no project path behind it opened nothing; removing it says so and ends no membership", async () => {
    // Left behind by an ended membership: a lane row, no project_members row.
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 4, '${SPANISH}', 400)`)
    const { body } = await post("owner", "removal-preview", { person: { userId: "4" }, grants: [{ type: "lane", id: SPANISH }] })
    expect(body.preview).toMatchObject({ removes: [{ grant: { type: "lane", id: SPANISH } }], loses: [], lanes: [{ before: null, after: null }] })
    expect((await removeLane("owner", SPANISH, "4")).body).toEqual({ removed: true, endedMembership: false })
    expect(await laneRows("4")).toEqual([])
  })

  it("a Project lead can neither give nor take a lane from a peer who leads the project through a team", async () => {
    // fixture/translators now leads Alpha: team_only is a Project lead there, with team lane rows at Contributor.
    await run("UPDATE group_project_grants SET role_level = 500 WHERE group_id = 1 AND project_id = 'p1'")
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('p1', 5, '${SPANISH}', 400), ('p1', 5, '${QUECHUA}', 400)`)
    await run("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 500, 1)")
    expect(await removeLane("org_lead", SPANISH, "5")).toMatchObject({ status: 403, body: { code: "target_outranks" } })
    expect(await grantLane("org_lead", SPANISH, "5", 100)).toMatchObject({ status: 403, body: { code: "target_outranks" } })
    expect(await laneRows("5")).toEqual([[SPANISH, 400], [QUECHUA, 400]])
    // A Maintainer may.
    expect((await removeLane("maintainer", SPANISH, "5")).status).toBe(200)
  })

  it("refuses a lane the person does not hold", async () => {
    await grantLane("owner", SPANISH, LUCIA, 400)
    expect(await removeLane("owner", QUECHUA, LUCIA)).toMatchObject({ status: 409, body: { code: "not_held" } })
  })
})
