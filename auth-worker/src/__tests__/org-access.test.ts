/**
 * AQU-1352 §3.6 (AQU-1072) — GET /api/v2/orgs/:orgId/access, the People &
 * access page. It must reuse the inspector's rule-4 visibility: an Owner sees
 * the whole org; a project lead without org-roster rights sees only projects
 * they can open, with no team structure and no names from hidden scopes.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import { FIXTURE_ORG_ID, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

interface Node { scope: { type: string; id: string; name: string }; children: Node[]; directGrantees: { displayName: string }[] }
interface Payload {
  tree: Node[]
  people: { userId: string; displayName: string; isGuest: boolean; grants: { scopePath: { id: string }[] }[] }[]
}

async function orgAccess(viewer: FixtureUser, orgId = FIXTURE_ORG_ID): Promise<Response> {
  return app.request(`/api/v2/orgs/${orgId}/access`, { headers: authHeader(await jwtFor(viewer)) }, env)
}

const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]
const projectIds = (p: Payload) =>
  [...new Set(p.tree.flatMap(flatten).filter((n) => n.scope.type === "project").map((n) => n.scope.id))].sort()

beforeEach(async () => {
  await seedAccessFixture()
})

describe("AQU-1352 §3.6 org People & access", () => {
  it("owner sees every team and live project, and every person", async () => {
    const res = await orgAccess("owner")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(body.tree[0].scope.type).toBe("org")
    // Archived projects are not part of the live access picture.
    expect(projectIds(body)).toEqual(["p1", "p2", "p3"])
    expect(body.tree[0].children.filter((n) => n.scope.type === "team").map((n) => n.scope.name).sort())
      .toEqual(["fixture/leads", "fixture/translators"])
    const names = body.people.map((p) => p.displayName)
    expect(names).toContain("external")
    // Rule 5: external holds only a project row → guest.
    expect(body.people.find((p) => p.displayName === "external")?.isGuest).toBe(true)
    expect(body.people.find((p) => p.displayName === "owner")?.isGuest).toBe(false)
  })

  it("a project lead below the org roster floor sees only projects they can see", async () => {
    // direct_above: 600 on p1, 400 on p2 via team, org 300 (below the roster floor).
    const res = await orgAccess("direct_above")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(projectIds(body)).toEqual(["p1"])
    // No team structure and no org-level grantees leak.
    expect(body.tree[0].children.every((n) => n.scope.type === "project")).toBe(true)
    expect(body.tree[0].directGrantees).toEqual([])
    const text = JSON.stringify(body)
    expect(text).not.toContain('"p2"')
    expect(text).not.toContain('"p3"')
    // external is only on p2; tim only reaches p3 — neither name ships.
    expect(text).not.toContain('"external"')
    expect(text).not.toContain('"tim"')
  })

  it("lists a person once per node even when they hold two grants there (creator + direct row)", async () => {
    // Found driving the page on a live stack: a project's creator who also has a
    // direct project_members row rendered twice under that project (React
    // duplicate-key warning). The tree shows who holds access at a node; the
    // person view is where every separate grant is itemised.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 700)",
    ).run()
    const body = (await (await orgAccess("owner")).json()) as Payload
    const p1 = body.tree.flatMap(flatten).filter((n) => n.scope.type === "project" && n.scope.id === "p1")
    for (const node of p1) {
      const names = node.directGrantees.map((g) => g.displayName)
      expect(names).toEqual([...new Set(names)])
    }
    expect(p1.some((n) => n.directGrantees.some((g) => g.displayName === "owner"))).toBe(true)
  })

  it("an outsider gets 403", async () => {
    expect((await orgAccess("personal")).status).toBe(403)
  })

  // Review finding: 404-for-missing vs 403-for-existing let any user probe
  // which org ids exist. Both must be indistinguishable.
  it("a missing org and an invisible org return the identical 403 (no id enumeration)", async () => {
    const hidden = await orgAccess("personal")
    const missing = await orgAccess("personal", 999999)
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual(await hidden.json())
  })
})
