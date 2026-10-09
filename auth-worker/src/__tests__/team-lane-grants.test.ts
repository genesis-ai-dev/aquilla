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

    it("grants only the scoped lane when the member already has a lane scope on the project", async () => {
      await seedOrg()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         VALUES ('p1', 3, 'lane', 'lane0002', '1', 0)`,
      ).run()
      expect((await addToTeam()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([{ lane: "lane0002", level: CONTRIBUTOR }])
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

    it("leaves a member's scoped lane set alone when the team is attached", async () => {
      await seedOrg({ attach: false })
      await onTeam(3)
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
         VALUES ('p1', 3, 'lane', 'lane0001', '1', 0)`,
      ).run()
      expect((await attachProject()).status).toBe(200)
      expect(await grantsFor(3)).toEqual([{ lane: "lane0001", level: CONTRIBUTOR }])
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
