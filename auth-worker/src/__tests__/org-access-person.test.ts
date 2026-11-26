/**
 * AQU-2323 — GET /api/v2/orgs/:orgId/access/people/:userId, the person
 * inspector's one read.
 *
 * The page answers "where can X go" for someone who may not see the whole
 * org. If it named a place, a path or a count the viewer's lenses hide, it
 * would leak the org's shape through any one person's page; if its roles
 * disagreed with the resolver, "Redundant, safe to remove" would be a lie that
 * removes real access. So every case checks the payload against the viewer's
 * own lens or against the write routes' real effect.
 *
 * Fixture (helpers/access-fixture.ts) plus:
 *   team 3 "Review desk" attached at Reviewer to r1 "Ruth" and r2 "Ezra";
 *   pedro (30): org Reviewer, on Review desk at Reviewer (added by maintainer
 *     2026-05-01) and a direct Reviewer on r1 (granted by owner 2026-06-02);
 *   lena (31): no org row, Project lead on r2 only;
 *   lanes ezra-es / ezra-fr on r2, alpha-es on p1.
 */
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { FIXTURE_ORG_ID, PERSONAL_ORG_ID, seedAccessFixture } from "./helpers/access-fixture"

const PEDRO = 30
const LENA = 31

interface Ref { type: string; id: string; name: string; hidden?: true }
interface Role { roleLevel: number; kind: string; via: Ref | null; alsoVia: Ref[]; redundantDirect: boolean }
interface Node { scope: Ref; role: Role; children: Node[] }
interface Card { grant: { type: string; id: string }; roleLevel: number; source: string; grantedBy: string | null; grantedAt: string | null; gives: Record<string, number>; redundant: boolean }
interface Payload {
  person: { userId: string; displayName: string; isGuest: boolean }
  counts: { grants: number; projects: number }
  tree: Node[]
  noAccess: { places: { scope: Ref }[]; counts: Record<string, number> }
  grants: Card[]
  history: { kind: string; at: string; by: string | null; path: Ref[]; roleBefore: number | null; roleAfter: number | null }[]
}

const run = (sql: string) => env.AQUILLA_PG.prepare(sql).run()

async function inspect(viewer: string, userId: number | string, orgId = FIXTURE_ORG_ID) {
  const res = await app.request(`/api/v2/orgs/${orgId}/access/people/${userId}`, { headers: authHeader(await jwtFor(viewer)) }, env)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as Payload }
}

const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children)])
const at = (p: Payload, key: string) => flat(p.tree).find((n) => `${n.scope.type}:${n.scope.id}` === key)

beforeEach(async () => {
  await seedAccessFixture()
  await seedUser(PEDRO, "pedro")
  await seedUser(LENA, "lena")
  await run(`INSERT INTO projects (id, name, org_id, created_by) VALUES ('r1', 'Ruth', 1, 1), ('r2', 'Ezra', 1, 1)`)
  await run(`INSERT INTO groups (id, org_id, name, created_by) VALUES (3, 1, 'Review desk', 1)`)
  await run(`INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (3, 'r1', 300, 1), (3, 'r2', 300, 1)`)
  await run(`INSERT INTO org_members (org_id, user_id, role_level, granted_by, granted_at) VALUES (1, ${PEDRO}, 300, 1, '2026-04-01T00:00:00Z')`)
  await run(`INSERT INTO group_members (group_id, user_id, added_by, added_at, role_level) VALUES (3, ${PEDRO}, 2, '2026-05-01T00:00:00Z', 300)`)
  await run(`INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at) VALUES ('r1', ${PEDRO}, 300, 1, '2026-06-02T00:00:00Z'), ('r2', ${LENA}, 500, 1, '2026-06-03T00:00:00Z')`)
  await run(
    `INSERT INTO lanes (id, project_id, role, language, name, position) VALUES
       ('ezra-es', 'r2', 'target', 'Spanish', 'Spanish', 0),
       ('ezra-fr', 'r2', 'target', 'French', 'French', 1),
       ('alpha-es', 'p1', 'target', 'Spanish', 'Spanish', 0)`,
  )
})

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("AQU-2323 person inspector", () => {
  it("AC1: Review desk solid, its projects dashed via the team, the direct grant solid and named redundant", async () => {
    const { status, body } = await inspect("owner", PEDRO)
    expect(status).toBe(200)
    expect(at(body, "team:3")?.role).toMatchObject({ roleLevel: 300, kind: "direct", via: null, redundantDirect: false })
    // r2: the team wins the tie with the org path (AQU-1274), and the org path is named as the second way in.
    expect(at(body, "project:r2")?.role).toMatchObject({ roleLevel: 300, kind: "inherited", via: { type: "team", id: "3", name: "Review desk" } })
    expect(at(body, "project:r1")?.role).toEqual({
      roleLevel: 300, kind: "direct", via: null, redundantDirect: true,
      alsoVia: [{ type: "team", id: "3", name: "Review desk" }],
    })
    // Each place is drawn once, under the first reached parent.
    expect(flat(body.tree).filter((n) => n.scope.id === "r1")).toHaveLength(1)
    expect(body.counts).toEqual({ grants: 3, projects: 2 })
  })

  it("AC2: the no-access bucket is the viewer's tree minus the places reached, counted by kind", async () => {
    const { body } = await inspect("owner", PEDRO)
    const reached = new Set(flat(body.tree).map((n) => `${n.scope.type}:${n.scope.id}`))
    const lens = (await (await app.request(`/api/v2/orgs/1/access`, { headers: authHeader(await jwtFor("owner")) }, env)).json()) as { tree: { scope: Ref; children: unknown[] }[] }
    const all = new Set<string>()
    const walk = (nodes: { scope: Ref; children: unknown[] }[]) => { for (const n of nodes) { all.add(`${n.scope.type}:${n.scope.id}`); walk(n.children as typeof nodes) } }
    walk(lens.tree)
    const missing = [...all].filter((k) => !reached.has(k)).sort()
    expect(body.noAccess.places.map((p) => `${p.scope.type}:${p.scope.id}`).sort()).toEqual(missing)
    expect(missing).toEqual(["lane:alpha-es", "project:p1", "project:p2", "project:p3", "team:1", "team:2"])
    expect(body.noAccess.counts).toEqual({ org: 0, team: 2, project: 3, lane: 1 })
  })

  it("AC4: the redundant card says so; removing it through the route leaves r1 at Reviewer via the team", async () => {
    const before = (await inspect("owner", PEDRO)).body
    const card = (type: string, id: string, p = before) => p.grants.find((g) => g.grant.type === type && g.grant.id === id)
    expect(card("project", "r1")).toMatchObject({ redundant: true, gives: { org: 0, team: 0, project: 0, lane: 0 } })
    expect(card("team", "3")).toMatchObject({ redundant: false, gives: { team: 1, project: 1, lane: 2 } })

    const res = await app.request(`/api/v2/projects/r1/members/${PEDRO}`, { method: "DELETE", headers: authHeader(await jwtFor("owner")) }, env)
    expect(res.status).toBe(200)
    const after = (await inspect("owner", PEDRO)).body
    expect(at(after, "project:r1")?.role).toMatchObject({ roleLevel: 300, kind: "inherited", via: { type: "team", id: "3" } })
    expect(card("project", "r1", after)).toBeUndefined()
  })

  it("AC5: history lists the grants with granter and date, newest first, plus recorded admin changes in this org only", async () => {
    await run(
      `INSERT INTO admin_audit_log (user_id, action, detail, created_at) VALUES
        (2, 'project.member.role', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":${PEDRO},"username":"pedro"},"scope":"project","orgId":null,"groupId":null,"projectId":"r2","roleBefore":200,"roleAfter":300}', '2026-07-01T00:00:00Z'),
        (2, 'project.member.remove', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":${PEDRO},"username":"pedro"},"scope":"project","orgId":null,"groupId":null,"projectId":"p_personal","roleBefore":300,"roleAfter":null}', '2026-07-02T00:00:00Z'),
        (2, 'project.member.role', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":${PEDRO}0,"username":"other"},"scope":"project","orgId":null,"groupId":null,"projectId":"r2","roleBefore":200,"roleAfter":300}', '2026-07-03T00:00:00Z')`,
    )
    const { body } = await inspect("owner", PEDRO)
    expect(body.history.map((h) => [h.kind, h.path[h.path.length - 1].id, h.by, h.at.slice(0, 10)])).toEqual([
      ["changed", "r2", "maintainer", "2026-07-01"],
      ["granted", "r1", "owner", "2026-06-02"],
      ["granted", "3", "maintainer", "2026-05-01"],
      ["granted", "1", "owner", "2026-04-01"],
    ])
  })

  it("lanes follow the read wall: open through the project with it off, closed without a lane row with it on", async () => {
    const off = (await inspect("owner", PEDRO)).body
    expect(at(off, "lane:ezra-es")?.role).toMatchObject({ roleLevel: 300, kind: "inherited", via: { type: "team", id: "3" } })

    env.LANE_READ_WALL = "1"
    await run(`INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by) VALUES ('r2', ${PEDRO}, 'ezra-es', 400, 1)`)
    const on = (await inspect("owner", PEDRO)).body
    expect(at(on, "lane:ezra-es")?.role).toMatchObject({ roleLevel: 400, kind: "direct", alsoVia: [] })
    expect(at(on, "lane:ezra-fr")).toBeUndefined()
    expect(on.noAccess.places.some((p) => p.scope.id === "ezra-fr")).toBe(true)
  })

  it("every miss is the same 403: a person off the viewer's roster, a foreign org, no such user, an invite id", async () => {
    // external (9) holds only a direct row on p2, which lena cannot see.
    const misses = [
      await inspect("lena", 9),
      await inspect("lena", PEDRO, PERSONAL_ORG_ID),
      await inspect("owner", 999),
      await inspect("owner", "invite:org:abc"),
      await inspect("lena", PEDRO, 4242),
    ]
    for (const miss of misses) {
      expect(miss.status).toBe(403)
      expect(miss.text).toBe('{"error":"no access to this roster"}')
    }
    // The same person lena's roster does show answers.
    expect((await inspect("lena", PEDRO)).status).toBe(200)
  })

  it("AC6: a Project lead viewing the org Owner sees only their own places; the payload names nothing else", async () => {
    await run(
      `INSERT INTO admin_audit_log (user_id, action, detail, created_at) VALUES
        (2, 'project.member.role', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":1,"username":"owner"},"scope":"project","orgId":null,"groupId":null,"projectId":"p1","roleBefore":600,"roleAfter":700}', '2026-07-01T00:00:00Z'),
        (2, 'org.member.role', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":1,"username":"owner"},"scope":"org","orgId":1,"groupId":null,"projectId":null,"roleBefore":600,"roleAfter":700}', '2026-07-02T00:00:00Z'),
        (2, 'project.member.role', '{"actor":{"userId":2,"username":"maintainer"},"target":{"userId":1,"username":"owner"},"scope":"project","orgId":null,"groupId":null,"projectId":"r2","roleBefore":600,"roleAfter":700}', '2026-07-03T00:00:00Z')`,
    )
    // Creation alone grants no roster visibility. Give the owner a second,
    // lower-ranked path through the same project-visible team as Pedro.
    expect((await inspect("lena", 1)).status).toBe(403)
    await run("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (3, 1, 2, 300)")
    const { status, text, body } = await inspect("lena", 1)
    expect(status).toBe(200)
    const keys = flat(body.tree).map((n) => `${n.scope.type}:${n.scope.id}`).sort()
    expect(keys).toEqual(["lane:ezra-es", "lane:ezra-fr", "project:r2"])
    // The org gives the role, but lena cannot see the org: the source is nameless.
    expect(at(body, "project:r2")?.role).toMatchObject({ roleLevel: 700, kind: "inherited", via: { type: "org", name: "", hidden: true } })
    expect(body.noAccess).toEqual({ places: [], counts: { org: 0, team: 0, project: 0, lane: 0 } })
    expect(body.history.map((h) => h.path[h.path.length - 1].id)).toEqual(["r2"])
    for (const hidden of ["Fixture Org", "Alpha", "Beta", "Gamma", "Ruth", "Review desk", "fixture/", '"p1"', '"p2"', '"p3"', '"r1"', "alpha-es"]) {
      expect(text).not.toContain(hidden)
    }
    // Pedro reaches r2 through Review desk, a team lena is not on: the role shows, the team's name and id do not.
    const pedro = await inspect("lena", PEDRO)
    expect(at(pedro.body, "project:r2")?.role).toMatchObject({ roleLevel: 300, kind: "inherited", via: { type: "team", id: "", name: "", hidden: true } })
    expect(pedro.text).not.toContain("Review desk")
    // The owner, looking at the same person, sees the org.
    expect(at((await inspect("owner", 1)).body, "org:1")?.role).toMatchObject({ roleLevel: 700, kind: "direct" })
  })
})
