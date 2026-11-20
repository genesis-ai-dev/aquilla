// AQU-2355: a lane grant grants only the lanes it lists.
//
// AQU-1781 made lane creation hand each new lane to every member below
// Maintainer who already held every other lane ("every lane, forever").
// AQU-2351 rule 2 retired that. A lane created later now reaches Maintainers
// and Owners (by role), its creator, and the people and teams picked in the
// same step — nobody else. A lane-less project's FIRST lane still goes to the
// members it already has.
//
// Pins it at every writer that can create a target lane:
//   * the POST /lanes route, with and without `grants`, and its candidates read
//   * `ensureProjectLaneStmts` and `ensureTargetLaneStmt` + `firstTargetLaneStmts`
//   * `linkTeamsToLaneStmts`, which the Codex ingest uses for each lane it creates

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  ensureProjectLaneStmts,
  ensureTargetLaneStmt,
  listProjectLanes,
} from "../../../db/shared/lanes"
import { firstTargetLaneStmts, linkTeamsToLaneStmts } from "../../../db/shared/lane-grants"

const PROJECT = "p-grant"

/**
 * user 1 = owner (project creator, 700). The members below are the people the
 * read wall applies to:
 *   2 = contributor (400), unscoped, holds French — AQU-1781 gave them every
 *       new lane; AQU-2355 gives them none unless picked
 *   3 = contributor (400), scoped to the French lane
 *   4 = maintainer (600) — above the wall, never granted
 *   5 = role 50, below Viewer — reads nothing, granted or not
 */
async function seedProject(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Grants', NULL, 1)",
  )
    .bind(PROJECT)
    .run()
  for (const [userId, level] of [
    [2, 400],
    [3, 400],
    [4, 600],
    [5, 50],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(PROJECT, userId, level)
      .run()
  }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', ?, 'source', 'Greek', NULL, NULL, NULL, 0),
      ('ln-fr', ?, 'target', 'French', NULL, NULL, 'French', 1)`,
  )
    .bind(PROJECT, PROJECT)
    .run()
  // user 3 is scoped to the one lane that exists, so a later lane is not theirs.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
     VALUES (?, 3, 'lane', 'ln-fr', '1', 0)`,
  )
    .bind(PROJECT)
    .run()
  // Everyone below Maintainer holds the lanes that existed when they joined —
  // what invite acceptance writes.
  for (const userId of [2, 3] as const) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, 'ln-fr', 400, 1)`,
    )
      .bind(PROJECT, userId)
      .run()
  }
}

async function grantsFor(userId: number): Promise<Array<{ lane: string; level: number }>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT lane, role_level FROM project_member_lane_roles
      WHERE project_id = ? AND user_id = ? ORDER BY lane`,
  )
    .bind(PROJECT, userId)
    .all<{ lane: string; role_level: number }>()
  return (rows.results ?? []).map((r) => ({ lane: r.lane, level: Number(r.role_level) }))
}

async function laneIdForTag(tag: string): Promise<string> {
  const lanes = await listProjectLanes(env.AQUILLA_PG, PROJECT)
  const lane = lanes.find((row) => row.role === "target" && row.legacyTag === tag)
  if (!lane) throw new Error(`no target lane for tag ${JSON.stringify(tag)}`)
  return lane.id
}

async function createLane(language: string, grants?: { userIds?: number[]; teamIds?: number[] }): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/lanes`,
    {
      method: "POST",
      headers: authHeader(await jwtFor("owner")),
      body: JSON.stringify({ name: "", language, ...(grants ? { grants } : {}) }),
    },
    env,
  )
}

async function sql(text: string, ...params: unknown[]): Promise<void> {
  await env.AQUILLA_PG.prepare(text).bind(...params).run()
}

/** Team 9 ("crew"), attached at Contributor and listing French; user 7 is on it only. */
async function seedTeam(opts: { codex?: boolean } = {}): Promise<void> {
  await seedUser(7, "crew-member")
  await sql(
    "INSERT INTO groups (id, org_id, name, created_by, legacy_uuid) VALUES (9, 1, 'crew', 1, ?)",
    opts.codex ? "gitlab-uuid" : null,
  )
  await sql("INSERT INTO group_members (group_id, user_id) VALUES (9, 7)")
  await sql(
    "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, lanes_explicit) VALUES (9, ?, 400, 1, TRUE)",
    PROJECT,
  )
  await sql("INSERT INTO group_project_lanes (group_id, project_id, lane_id) VALUES (9, ?, 'ln-fr')", PROJECT)
  await sql(
    "INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by) VALUES (?, 7, 'ln-fr', 400, 1)",
    PROJECT,
  )
}

async function teamLanes(): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT lane_id FROM group_project_lanes WHERE group_id = 9 AND project_id = ? ORDER BY lane_id",
  )
    .bind(PROJECT)
    .all<{ lane_id: string }>()
  return (rows.results ?? []).map((r) => r.lane_id)
}

beforeEach(async () => {
  for (const [id, name] of [
    [1, "owner"],
    [2, "unscoped"],
    [3, "scoped"],
    [4, "maintainer"],
    [5, "guest"],
  ] as const) {
    await seedUser(id, name)
  }
  await seedProject()
})

describe("AQU-2355 POST /lanes grants the new lane to nobody below Maintainer", () => {
  it("leaves every member below Maintainer as they were, and Maintainers need no row", async () => {
    const res = await createLane("Spanish")
    expect(res.status).toBe(201)
    expect(await grantsFor(2)).toEqual([{ lane: "ln-fr", level: 400 }])
    expect(await grantsFor(3)).toEqual([{ lane: "ln-fr", level: 400 }])
    expect(await grantsFor(4)).toEqual([])
    expect(await grantsFor(5)).toEqual([])
  })

  it("grants the new lane to the project lead who created it, and to nobody else", async () => {
    await seedUser(6, "lead")
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 6, 500, 1)", PROJECT)
    await sql(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES (?, 6, 'lane', 'ln-fr', '1', 0)`,
      PROJECT,
    )
    await sql(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, 6, 'ln-fr', 400, 1)`,
      PROJECT,
    )
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/lanes`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ name: "", language: "Spanish" }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect((await grantsFor(6)).map((g) => g.lane).sort()).toEqual([laneId, "ln-fr"].sort())
    expect(await grantsFor(2)).toEqual([{ lane: "ln-fr", level: 400 }])
  })

  it("gives a lane-less project's first lane to its unscoped direct members, and a team only when picked", async () => {
    await seedTeam()
    await sql("DELETE FROM project_member_lane_roles WHERE project_id = ?", PROJECT)
    await sql("DELETE FROM group_project_lanes WHERE project_id = ?", PROJECT)
    await sql("DELETE FROM lanes WHERE project_id = ? AND role = 'target'", PROJECT)
    expect((await createLane("Spanish")).status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect((await grantsFor(2)).map((g) => g.lane)).toEqual([laneId])
    // AQU-2563: a team reaches a lane only through its attachment, which lists none.
    expect(await grantsFor(7)).toEqual([])
    expect(await teamLanes()).toEqual([])
    expect(await grantsFor(3)).toEqual([])
    expect(await grantsFor(4)).toEqual([])

    // A team on no lane yet is offered to the owner, and picking it links it.
    await sql("DELETE FROM project_member_lane_roles WHERE project_id = ?", PROJECT)
    await sql("DELETE FROM lanes WHERE project_id = ? AND role = 'target'", PROJECT)
    const offer = await app.request(
      `/api/v2/projects/${PROJECT}/lanes/grant-candidates`,
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    const body = (await offer.json()) as { teams: Array<{ groupId: number; laneNames: string[] }> }
    expect(body.teams).toEqual([expect.objectContaining({ groupId: 9, laneNames: [] })])
    expect((await createLane("Twi", { teamIds: [9] })).status).toBe(201)
    const twi = await laneIdForTag("Twi")
    expect(await teamLanes()).toEqual([twi])
    expect((await grantsFor(7)).map((g) => g.lane)).toEqual([twi])
  })

  it("offers the people and teams on the other lanes, with their role, and nobody at Maintainer+", async () => {
    await seedTeam()
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/lanes/grant-candidates`,
      { headers: authHeader(await jwtFor("owner")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      people: Array<{ userId: number; roleLevel: number; laneNames: string[] }>
      teams: Array<{ groupId: number; name: string; roleLevel: number; laneNames: string[] }>
    }
    // 7 reaches the project only through the team, so the team is offered instead.
    // Sorted by name: "scoped" (3) before "unscoped" (2).
    expect(body.people.map((p) => [p.userId, p.roleLevel, p.laneNames])).toEqual([
      [3, 400, ["French"]],
      [2, 400, ["French"]],
    ])
    expect(body.teams.map((t) => [t.groupId, t.name, t.roleLevel, t.laneNames])).toEqual([[9, "crew", 400, ["French"]]])
  })

  it("grants exactly the people and teams picked, at the role they hold, and nothing else", async () => {
    await seedTeam()
    expect((await createLane("Spanish", { userIds: [2], teamIds: [9] })).status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect(await grantsFor(2)).toEqual(
      [
        { lane: laneId, level: 400 },
        { lane: "ln-fr", level: 400 },
      ].sort((a, b) => a.lane.localeCompare(b.lane)),
    )
    expect(await grantsFor(3)).toEqual([{ lane: "ln-fr", level: 400 }])
    expect((await grantsFor(7)).map((g) => g.lane).sort()).toEqual([laneId, "ln-fr"].sort())
    expect(await teamLanes()).toEqual([laneId, "ln-fr"].sort())
  })

  it("refuses a pick that is not on the offer, and creates no lane", async () => {
    // 4 is a Maintainer (sees every lane by role); 5 holds no lane.
    for (const userId of [4, 5]) {
      expect((await createLane("Spanish", { userIds: [userId] })).status).toBe(400)
    }
    const lanes = await listProjectLanes(env.AQUILLA_PG, PROJECT)
    expect(lanes.some((lane) => lane.legacyTag === "Spanish")).toBe(false)
  })

  it("writes no duplicate rows when the same language is asked for twice", async () => {
    expect((await createLane("Spanish", { userIds: [2] })).status).toBe(201)
    expect((await createLane("Spanish", { userIds: [2] })).status).toBe(409)
    expect((await grantsFor(2)).length).toBe(2)
  })
})

describe("AQU-2355 the server-side lane writers", () => {
  it("ensureProjectLaneStmts grants a later lane to nobody", async () => {
    const stmts = ensureProjectLaneStmts(env.AQUILLA_PG, PROJECT, {
      lanes: [{ role: "target", language: "Swahili", legacyTag: "Swahili" }],
    })
    await env.AQUILLA_PG.batch(stmts)
    await laneIdForTag("Swahili")
    expect(await grantsFor(2)).toEqual([{ lane: "ln-fr", level: 400 }])
  })

  it("ensureTargetLaneStmt + firstTargetLaneStmts grant only a project's first lane, and re-running adds no rows", async () => {
    const run = () =>
      env.AQUILLA_PG.batch([
        ensureTargetLaneStmt(env.AQUILLA_PG, PROJECT, "Tshangla"),
        ...firstTargetLaneStmts(env.AQUILLA_PG, PROJECT, { legacyTag: "Tshangla" }, null),
      ])
    await run()
    await laneIdForTag("Tshangla")
    expect(await grantsFor(2)).toEqual([{ lane: "ln-fr", level: 400 }])
    await sql("DELETE FROM project_member_lane_roles WHERE project_id = ?", PROJECT)
    await sql("DELETE FROM lanes WHERE project_id = ? AND role = 'target'", PROJECT)
    await run()
    const first = await laneIdForTag("Tshangla")
    expect(await grantsFor(2)).toEqual([{ lane: first, level: 400 }])
    await run()
    expect(await grantsFor(2)).toEqual([{ lane: first, level: 400 }])
  })

  it("linkTeamsToLaneStmts (Codex) links the Codex team to a lane it created and grants its members", async () => {
    await seedTeam({ codex: true })
    await env.AQUILLA_PG.batch(
      ensureProjectLaneStmts(env.AQUILLA_PG, PROJECT, {
        lanes: [{ role: "target", language: "Swahili", legacyTag: "Swahili" }],
      }),
    )
    const laneId = await laneIdForTag("Swahili")
    expect(await teamLanes()).toEqual(["ln-fr"])
    await env.AQUILLA_PG.batch(linkTeamsToLaneStmts(env.AQUILLA_PG, PROJECT, laneId, { codex: true }, null))
    expect(await teamLanes()).toEqual([laneId, "ln-fr"].sort())
    expect((await grantsFor(7)).map((g) => g.lane).sort()).toEqual([laneId, "ln-fr"].sort())
    // A direct member is not on the team, so the team link gives them nothing.
    expect(await grantsFor(2)).toEqual([{ lane: "ln-fr", level: 400 }])
  })

  it("linkTeamsToLaneStmts (Codex) leaves a team the Codex sync did not make alone", async () => {
    await seedTeam({ codex: false })
    await env.AQUILLA_PG.batch(
      ensureProjectLaneStmts(env.AQUILLA_PG, PROJECT, {
        lanes: [{ role: "target", language: "Swahili", legacyTag: "Swahili" }],
      }),
    )
    const laneId = await laneIdForTag("Swahili")
    await env.AQUILLA_PG.batch(linkTeamsToLaneStmts(env.AQUILLA_PG, PROJECT, laneId, { codex: true }, null))
    expect(await teamLanes()).toEqual(["ln-fr"])
    expect(await grantsFor(7)).toEqual([{ lane: "ln-fr", level: 400 }])
  })
})
