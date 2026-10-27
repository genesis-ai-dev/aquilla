import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// AQU-1801: the three in-app team writes — adding an org member to a team,
// attaching a team to a project, and changing the team's role on a project —
// wrote `group_members` / `group_project_grants` and nothing else. Under the
// lane read wall a member below Maintainer reads a target lane only through a
// `project_member_lane_roles` row, so anyone admitted through a team after the
// AQU-730 backfill opened the project and saw no target lane, with every
// indicator still green. AQU-1782 closed the same gap for direct Add member;
// these paths now go through the same writer.

const VIEWER = 100
const CONTRIBUTOR = 400
const PROJECT_LEAD = 500
const MAINTAINER = 600

type Grant = { lane: string; level: number }

async function seedOrg(opts: { attach?: boolean; lanes?: boolean; carolOrgRole?: number } = {}) {
  await seedUser(1, "alice")
  await seedUser(3, "carol")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 3, ?, 1)`,
  )
    .bind(opts.carolOrgRole ?? VIEWER)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Shared', 1, 1)",
  ).run()
  if (opts.lanes !== false) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
         ('src00001', 'p1', 'source', 'Greek', NULL, 0),
         ('lane0001', 'p1', 'target', 'Bemba', '', 1),
         ('lane0002', 'p1', 'target', 'Dzongkha', 'dz', 2)`,
    ).run()
  }
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'Team T', 1)",
  ).run()
  if (opts.attach !== false) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by)
       VALUES (1, 'p1', ?, 1)`,
    )
      .bind(CONTRIBUTOR)
      .run()
  }
}

async function addToTeam(username = "carol") {
  return app.request(
    "/api/v2/orgs/1/groups/1/members",
    { method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ username }) },
    env,
  )
}

async function onTeam(userId: number) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (1, ?, 1)",
  )
    .bind(userId)
    .run()
}

async function attachProject(roleLevel = CONTRIBUTOR) {
  return app.request(
    "/api/v2/orgs/1/groups/1/projects",
    {
      method: "POST",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify({ projectId: "p1", roleLevel }),
    },
    env,
  )
}

async function setAttachmentRole(roleLevel: number) {
  return app.request(
    "/api/v2/orgs/1/groups/1/projects/p1",
    { method: "PATCH", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ roleLevel }) },
    env,
  )
}

async function grantsFor(userId: number): Promise<Grant[]> {
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT lane, role_level FROM project_member_lane_roles
      WHERE project_id = 'p1' AND user_id = ? ORDER BY lane`,
  )
    .bind(userId)
    .all<{ lane: string; role_level: number }>()
  return (results ?? []).map((r) => ({ lane: r.lane, level: Number(r.role_level) }))
}

describe("team writes — lane grants (AQU-1801)", () => {
  describe("POST /orgs/:orgId/groups/:groupId/members", () => {
    it("grants the target lanes of every attached project to someone added to the team", async () => {
      await seedOrg()
      expect((await addToTeam()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })

    it("writes no rows for someone whose org role already clears the wall", async () => {
      await seedOrg({ carolOrgRole: MAINTAINER })
      expect((await addToTeam()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([])
    })

    it("replaces a leftover lane scope with the team's lanes", async () => {
      await seedOrg()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         VALUES ('p1', 3, 'lane', 'lane0002', '1', 0)`,
      ).run()
      expect((await addToTeam()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })

    it("adds the member without grants when the team has no project attached", async () => {
      await seedOrg({ attach: false })
      expect((await addToTeam()).status).toBe(200)
      const row = await env.AQUILLA_PG.prepare(
        "SELECT user_id FROM group_members WHERE group_id = 1 AND user_id = 3",
      ).first<{ user_id: number }>()
      expect(Number(row?.user_id)).toBe(3)
      expect(await grantsFor(3)).toEqual([])
    })

    it("re-adding the same member does not duplicate grant rows", async () => {
      await seedOrg()
      expect((await addToTeam()).status).toBe(200)
      expect((await addToTeam()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })

    it("writes grants for every person in a batch add", async () => {
      await seedOrg()
      await seedUser(4, "dave")
      await env.AQUILLA_PG.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 4, 100, 1)",
      ).run()
      const res = await app.request(
        "/api/v2/orgs/1/groups/1/members",
        {
          method: "POST",
          headers: authHeader(await jwtFor("alice")),
          body: JSON.stringify({ usernames: ["carol", "dave"] }),
        },
        env,
      )
      expect(res.status).toBe(200)
      expect(await grantsFor(3)).toHaveLength(2)
      expect(await grantsFor(4)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })
  })

  describe("POST /orgs/:orgId/groups/:groupId/projects", () => {
    it("grants the project's target lanes to every team member below Maintainer", async () => {
      await seedOrg({ attach: false })
      await seedUser(5, "erin")
      await env.AQUILLA_PG.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 5, 600, 1)",
      ).run()
      await onTeam(3)
      await onTeam(5)
      expect((await attachProject()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
      // erin is an org Maintainer — her role already clears the wall.
      expect(await grantsFor(5)).toEqual([])
    })

    it("gives a leftover scope the lanes of the attachment", async () => {
      await seedOrg({ attach: false })
      await onTeam(3)
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         VALUES ('p1', 3, 'lane', 'lane0001', '1', 0)`,
      ).run()
      expect((await attachProject()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })

    it("grants only the lanes the attachment checks", async () => {
      await seedOrg({ attach: false })
      await onTeam(3)
      const res = await app.request(
        "/api/v2/orgs/1/groups/1/projects",
        {
          method: "POST",
          headers: authHeader(await jwtFor("alice")),
          body: JSON.stringify({ projectId: "p1", roleLevel: CONTRIBUTOR, laneIds: ["lane0002"] }),
        },
        env,
      )
      expect(res.status).toBe(200)
      expect(await grantsFor(3)).toEqual([{ lane: "lane0002", level: CONTRIBUTOR }])
    })

    it("re-attaching the same project does not duplicate grant rows", async () => {
      await seedOrg({ attach: false })
      await onTeam(3)
      expect((await attachProject()).status).toBe(200)
      expect((await attachProject()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })
  })

  describe("PATCH /orgs/:orgId/groups/:groupId/projects/:projectId", () => {
    it("moves the grant level to the role the team now holds, keeping the same lanes", async () => {
      await seedOrg({ attach: false })
      await onTeam(3)
      expect((await attachProject()).status).toBe(200)

      expect((await setAttachmentRole(VIEWER)).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: VIEWER },
        { lane: "lane0002", level: VIEWER },
      ])

      expect((await setAttachmentRole(CONTRIBUTOR)).status).toBe(200)
      expect(await grantsFor(3)).toEqual([
        { lane: "lane0001", level: CONTRIBUTOR },
        { lane: "lane0002", level: CONTRIBUTOR },
      ])
    })

    it("re-levels without widening a member whose grants cover one lane only", async () => {
      await seedOrg()
      await onTeam(3)
      // Joined before lane0002 existed: the role change must not hand her a
      // lane she could not read before.
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
         VALUES ('p1', 3, 'lane0001', ?, 1)`,
      )
        .bind(CONTRIBUTOR)
        .run()
      expect((await setAttachmentRole(VIEWER)).status).toBe(200)
      expect(await grantsFor(3)).toEqual([{ lane: "lane0001", level: VIEWER }])
    })
  })
})

// AQU-1809: PATCH .../groups/:groupId/members/:userId wrote group_members.role_level
// and left project_member_lane_roles at the old level. A promotion stayed
// read-only; a demotion could still edit. The lane set does not move.
describe("PATCH team-scope role — lane grants (AQU-1809)", () => {
  async function seedAttached(opts: { carolOrgRole?: number } = {}) {
    await seedUser(1, "alice")
    await seedUser(3, "carol")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       VALUES (1, 1, 700, 1), (1, 3, ?, 1)`,
    )
      .bind(opts.carolOrgRole ?? VIEWER)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by) VALUES
         ('p1', 'One', 1, 1),
         ('p2', 'Two', 1, 1),
         ('p3', 'Aside', 1, 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
         ('lane0001', 'p1', 'target', 'Bemba', '', 1),
         ('lane0002', 'p1', 'target', 'Dzongkha', 'dz', 2),
         ('lane0003', 'p2', 'target', 'Ewe', '', 1),
         ('lane0004', 'p2', 'target', 'Fula', 'ff', 2),
         ('lane0005', 'p3', 'target', 'Ga', '', 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'Team T', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by)
       VALUES (1, 'p1', ?, 1), (1, 'p2', ?, 1)`,
    )
      .bind(VIEWER, VIEWER)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id, role_level, added_by) VALUES (1, 3, ?, 1)",
    )
      .bind(VIEWER)
      .run()
  }

  async function setTeamRole(roleLevel: number) {
    return app.request(
      "/api/v2/orgs/1/groups/1/members/3",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ roleLevel }),
      },
      env,
    )
  }

  async function grantsOn(projectId: string, userId = 3): Promise<Grant[]> {
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT lane, role_level FROM project_member_lane_roles
        WHERE project_id = ? AND user_id = ? ORDER BY lane`,
    )
      .bind(projectId, userId)
      .all<{ lane: string; role_level: number }>()
    return (results ?? []).map((r) => ({ lane: r.lane, level: Number(r.role_level) }))
  }

  async function grantAt(projectId: string, lane: string, level: number) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, 3, ?, ?, 1)`,
    )
      .bind(projectId, lane, level)
      .run()
  }

  it("moves existing rows up on every project the team is attached to", async () => {
    await seedAttached()
    await grantAt("p1", "lane0001", VIEWER)
    await grantAt("p1", "lane0002", VIEWER)
    await grantAt("p2", "lane0003", VIEWER)
    await grantAt("p2", "lane0004", VIEWER)
    // Not attached: this row is not this team's to move.
    await grantAt("p3", "lane0005", VIEWER)

    expect((await setTeamRole(PROJECT_LEAD)).status).toBe(200)
    expect(await grantsOn("p1")).toEqual([
      { lane: "lane0001", level: PROJECT_LEAD },
      { lane: "lane0002", level: PROJECT_LEAD },
    ])
    expect(await grantsOn("p2")).toEqual([
      { lane: "lane0003", level: PROJECT_LEAD },
      { lane: "lane0004", level: PROJECT_LEAD },
    ])
    expect(await grantsOn("p3")).toEqual([{ lane: "lane0005", level: VIEWER }])

    expect((await setTeamRole(PROJECT_LEAD)).status).toBe(200)
    expect(await grantsOn("p1")).toHaveLength(2)
    expect(await grantsOn("p2")).toHaveLength(2)
  })

  it("moves existing rows down when the team-scope role drops", async () => {
    await seedAttached()
    await env.AQUILLA_PG.prepare(
      "UPDATE group_members SET role_level = ? WHERE group_id = 1 AND user_id = 3",
    )
      .bind(PROJECT_LEAD)
      .run()
    await grantAt("p1", "lane0001", PROJECT_LEAD)
    await grantAt("p1", "lane0002", PROJECT_LEAD)
    await grantAt("p2", "lane0003", PROJECT_LEAD)

    expect((await setTeamRole(VIEWER)).status).toBe(200)
    expect(await grantsOn("p1")).toEqual([
      { lane: "lane0001", level: VIEWER },
      { lane: "lane0002", level: VIEWER },
    ])
    expect(await grantsOn("p2")).toEqual([{ lane: "lane0003", level: VIEWER }])
  })

  it("writes no rows when another path already resolves to Maintainer", async () => {
    await seedAttached({ carolOrgRole: MAINTAINER })
    await grantAt("p1", "lane0001", VIEWER)
    await grantAt("p1", "lane0002", CONTRIBUTOR)
    await grantAt("p2", "lane0003", VIEWER)

    expect((await setTeamRole(PROJECT_LEAD)).status).toBe(200)
    expect(await grantsOn("p1")).toEqual([])
    expect(await grantsOn("p2")).toEqual([])
  })

  it("leaves a scoped member's lanes exactly as they were", async () => {
    await seedAttached()
    await grantAt("p1", "lane0002", VIEWER)
    await grantAt("p2", "lane0004", VIEWER)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES ('p1', 3, 'lane', 'lane0002', '1', 0),
              ('p2', 3, 'lane', 'lane0004', '1', 0)`,
    ).run()

    expect((await setTeamRole(PROJECT_LEAD)).status).toBe(200)
    expect(await grantsOn("p1")).toEqual([{ lane: "lane0002", level: PROJECT_LEAD }])
    expect(await grantsOn("p2")).toEqual([{ lane: "lane0004", level: PROJECT_LEAD }])
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT project_id, value FROM project_member_scopes
        WHERE user_id = 3 AND kind = 'lane' ORDER BY project_id`,
    ).all<{ project_id: string; value: string }>()
    expect(results ?? []).toEqual([
      { project_id: "p1", value: "lane0002" },
      { project_id: "p2", value: "lane0004" },
    ])
  })
})

// AQU-1818: revoking a direct membership used to leave lane scopes and grant
// rows behind. A later team path then re-levelled that one lane, so someone
// who rejoined through a team did not get the lanes the team grants.
describe("a removed member who returns through a team (AQU-1818)", () => {
  async function addScoped(lane = "lane0002") {
    return app.request(
      "/api/v2/projects/p1/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ username: "carol", role: CONTRIBUTOR, scopeLanes: [lane] }),
      },
      env,
    )
  }

  async function revokeAll() {
    return app.request(
      "/api/v2/projects/p1/members/3/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("alice")), body: "{}" },
      env,
    )
  }

  async function scopesFor(): Promise<string[]> {
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT value FROM project_member_scopes
        WHERE project_id = 'p1' AND user_id = 3 AND kind = 'lane' ORDER BY value`,
    ).all<{ value: string }>()
    return (results ?? []).map((row) => row.value)
  }

  const bothLanes = [
    { lane: "lane0001", level: CONTRIBUTOR },
    { lane: "lane0002", level: CONTRIBUTOR },
  ]

  it("revoke then attach grants every current lane and leaves no scope", async () => {
    await seedOrg({ attach: false })
    await onTeam(3)
    expect((await addScoped()).status).toBe(200)
    expect(await grantsFor(3)).toEqual([{ lane: "lane0002", level: CONTRIBUTOR }])

    expect((await revokeAll()).status).toBe(200)
    expect(await grantsFor(3)).toEqual([])
    expect(await scopesFor()).toEqual([])

    expect((await attachProject(CONTRIBUTOR)).status).toBe(200)
    expect(await grantsFor(3)).toEqual(bothLanes)
    expect(await scopesFor()).toEqual([])
  })

  it("revoke then add-to-team grants every current lane and leaves no scope", async () => {
    await seedOrg()
    expect((await addScoped()).status).toBe(200)
    expect((await revokeAll()).status).toBe(200)
    expect(await grantsFor(3)).toEqual([])
    expect(await scopesFor()).toEqual([])

    expect((await addToTeam()).status).toBe(200)
    expect(await grantsFor(3)).toEqual(bothLanes)
    expect(await scopesFor()).toEqual([])
  })

  it("revoking only the direct membership leaves the team's lanes in place", async () => {
    await seedOrg()
    expect((await addToTeam()).status).toBe(200)
    expect(await grantsFor(3)).toEqual(bothLanes)
    // The direct add narrows her to one lane. Revoking that membership must
    // restore the lanes the team already conferred, not keep the old limit.
    expect((await addScoped()).status).toBe(200)
    expect(await grantsFor(3)).toEqual([{ lane: "lane0002", level: CONTRIBUTOR }])

    expect((await revokeAll()).status).toBe(200)
    expect(await grantsFor(3)).toEqual(bothLanes)
    expect(await scopesFor()).toEqual([])
  })

  it("a current lane-scoped member who also joins the team keeps those lanes", async () => {
    await seedOrg()
    expect((await addScoped()).status).toBe(200)
    expect((await addToTeam()).status).toBe(200)
    expect(await grantsFor(3)).toEqual([{ lane: "lane0002", level: CONTRIBUTOR }])
    expect(await scopesFor()).toEqual(["lane0002"])
  })

  it("a team role change ignores a scope left by a membership that has ended", async () => {
    await seedOrg()
    await onTeam(3)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES ('p1', 3, 'lane', 'lane0002', '1', 0)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES ('p1', 3, 'lane0002', ?, 1)`,
    )
      .bind(CONTRIBUTOR)
      .run()

    expect((await setAttachmentRole(VIEWER)).status).toBe(200)
    expect(await grantsFor(3)).toEqual([
      { lane: "lane0001", level: VIEWER },
      { lane: "lane0002", level: VIEWER },
    ])
    expect(await scopesFor()).toEqual([])
  })
})
