import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-1782: direct add (POST /projects/:id/members) wrote the membership row
// and nothing else, so under the lane read/write wall a below-Maintainer
// member held zero lane grants — no target lane in the switcher, no target
// cells, 0% progress — while the member inspector called them "unscoped".
// Direct add now writes grants through the same planner invite acceptance
// uses, and a role change through the same route rewrites the level on the
// rows the member already has without widening their lane set.

async function seedOrg(opts: { lanes?: boolean } = {}) {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 2, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Shared', 1, 1)",
  ).run()
  if (opts.lanes !== false) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
         ('src00001', 'p1', 'source', 'Greek', NULL, 0),
         ('lane0001', 'p1', 'target', 'Tshangla', '', 1),
         ('lane0002', 'p1', 'target', 'Dzongkha', 'dz', 2)`,
    ).run()
  }
}

async function addMember(
  role: number,
  username = "bob",
  lanes: { allCurrentLanes: true } | { scopeLanes: string[] } | null = { allCurrentLanes: true },
) {
  return app.request(
    "/api/v2/projects/p1/members",
    {
      method: "POST",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify(lanes ? { username, role, ...lanes } : { username, role }),
    },
    env,
  )
}

async function grantsFor(userId: number): Promise<Array<{ lane: string; level: number }>> {
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT lane, role_level FROM project_member_lane_roles
      WHERE project_id = 'p1' AND user_id = ? ORDER BY lane`,
  )
    .bind(userId)
    .all<{ lane: string; role_level: number }>()
  return (results ?? []).map((r) => ({ lane: r.lane, level: Number(r.role_level) }))
}

describe("POST /api/v2/projects/:id/members — lane grants (AQU-1782)", () => {
  it("refuses a new contributor when the lanes were not chosen", async () => {
    await seedOrg()
    const res = await addMember(300, "bob", null)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("target lanes") })
    expect(await grantsFor(2)).toEqual([])
  })

  it("grants every current target lane when that choice is explicit", async () => {
    await seedOrg()
    const res = await addMember(300)
    expect(res.status).toBe(200)
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 300 },
      { lane: "lane0002", level: 300 },
    ])
  })

  it("grants only the lanes named on the add", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 300 }])
    const scopes = await env.AQUILLA_PG.prepare(
      `SELECT value FROM project_member_scopes
        WHERE project_id = 'p1' AND user_id = 2 AND kind = 'lane'`,
    ).all<{ value: string }>()
    expect((scopes.results ?? []).map((row) => row.value)).toEqual(["lane0002"])
  })

  it("writes no grant rows for a Maintainer — their role already clears the wall", async () => {
    await seedOrg()
    expect((await addMember(600, "bob", undefined)).status).toBe(200)
    expect(await grantsFor(2)).toEqual([])
  })

  it("adds the member without error and without grants on a project that has no lanes yet", async () => {
    await seedOrg({ lanes: false })
    expect((await addMember(300, "bob", undefined)).status).toBe(200)
    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'p1' AND user_id = 2",
    ).first<{ role_level: number }>()
    expect(Number(row?.role_level)).toBe(300)
    expect(await grantsFor(2)).toEqual([])
  })

  it("re-adding the same member at the same role does not duplicate grant rows", async () => {
    await seedOrg()
    expect((await addMember(300)).status).toBe(200)
    expect((await addMember(300)).status).toBe(200)
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 300 },
      { lane: "lane0002", level: 300 },
    ])
  })

  it("a role change rewrites the level on the rows the member has, keeping the same lanes", async () => {
    await seedOrg()
    // One lane only — e.g. the member joined before lane0002 existed. The
    // promotion must not hand them a lane they could not read before.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES ('p1', 2, 'lane0001', 300, 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES ('p1', 2, 300, 1)`,
    ).run()
    // A role change names no lanes (AQU-1808): the lanes they hold stay.
    expect((await addMember(400, "bob", null)).status).toBe(200)
    expect(await grantsFor(2)).toEqual([{ lane: "lane0001", level: 400 }])
  })

  it("writes grants for every person in a batch add", async () => {
    await seedOrg()
    await seedUser(3, "carol")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 3, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          members: [
            { username: "bob", role: 300, allCurrentLanes: true },
            { username: "carol", role: 400, allCurrentLanes: true },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 300 },
      { lane: "lane0002", level: 300 },
    ])
    expect(await grantsFor(3)).toEqual([
      { lane: "lane0001", level: 400 },
      { lane: "lane0002", level: 400 },
    ])
  })
})

// AQU-1808: the choice on an add is the whole truth about the person's lanes.
// Removing a member deletes only project_members, so the scope and grant rows
// of an earlier membership survive the removal. Before this, a re-add that
// chose "every current lane" inherited an old one-lane narrowing (the planner
// only re-levelled the rows that existed, and the stale scope row kept the
// client on that lane), and a re-add that named one lane kept an earlier
// every-lane grant set. A fresh membership starts from no lane rows; a lane
// list given for an existing member replaces theirs; a promotion to project
// lead drops the scope rows a lead must not carry (AD-12).
describe("POST /api/v2/projects/:id/members — the lane choice replaces what an earlier membership left (AQU-1808)", () => {
  async function laneScopesFor(userId: number): Promise<string[]> {
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT value FROM project_member_scopes
        WHERE project_id = 'p1' AND user_id = ? AND kind = 'lane' ORDER BY value`,
    )
      .bind(userId)
      .all<{ value: string }>()
    return (results ?? []).map((row) => row.value)
  }

  async function removeMember(userId: number) {
    return app.request(
      `/api/v2/projects/p1/members/${userId}`,
      { method: "DELETE", headers: authHeader(await jwtFor("alice")) },
      env,
    )
  }

  async function revokeAll(userId: number) {
    return app.request(
      `/api/v2/projects/p1/members/${userId}/revoke-all`,
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: "{}" },
      env,
    )
  }

  it("re-adding someone with every current lane after they were removed grants every lane again", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect((await removeMember(2)).status).toBe(200)
    // The removal leaves the old rows behind — that is the state a re-add meets.
    expect(await laneScopesFor(2)).toEqual(["lane0002"])
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 300 }])

    expect((await addMember(300)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual([])
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 300 },
      { lane: "lane0002", level: 300 },
    ])
  })

  it("re-adding someone as project lead after revoke-all drops the stale lane scope", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect((await revokeAll(2)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual(["lane0002"])

    expect((await addMember(500, "bob", null)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual([])
    // A lead below the Maintainer wall holds a grant on each current lane.
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 500 },
      { lane: "lane0002", level: 500 },
    ])
  })

  it("re-adding someone with one lane after they held every lane grants only that lane", async () => {
    await seedOrg()
    expect((await addMember(300)).status).toBe(200)
    expect((await removeMember(2)).status).toBe(200)
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 300 },
      { lane: "lane0002", level: 300 },
    ])

    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual(["lane0002"])
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 300 }])
  })

  it("a lane list named on the add of an existing member replaces the lanes they held", async () => {
    await seedOrg()
    expect((await addMember(300)).status).toBe(200)
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual(["lane0002"])
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 300 }])
  })

  it("every current lane named on the add of an existing member widens a narrowed one", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect((await addMember(400)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual([])
    expect(await grantsFor(2)).toEqual([
      { lane: "lane0001", level: 400 },
      { lane: "lane0002", level: 400 },
    ])
  })

  it("a role change that names no lanes keeps a narrowed member on their lanes", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect((await addMember(400, "bob", null)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual(["lane0002"])
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 400 }])
  })

  it("promoting an existing member to project lead drops their lane scope rows and only re-levels their grants", async () => {
    await seedOrg()
    expect((await addMember(300, "bob", { scopeLanes: ["lane0002"] })).status).toBe(200)
    expect((await addMember(500, "bob", null)).status).toBe(200)
    expect(await laneScopesFor(2)).toEqual([])
    // The grant set is what a later demotion through this route restores.
    expect(await grantsFor(2)).toEqual([{ lane: "lane0002", level: 500 }])
  })
})
