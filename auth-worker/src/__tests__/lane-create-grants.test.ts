// AQU-1781: creating a target lane grants it to the members who already read
// every lane.
//
// Under the lane read wall a member below Maintainer reads only the lanes they
// hold a `project_member_lane_roles` row for. Lane creation wrote none, so a
// lane added after a member joined was invisible to them — while the member
// inspector still called them "Unscoped — full access".
//
// Pins the rule at every writer that can create a target lane:
//   * the POST /lanes route (Project Settings → Languages, and every client
//     "add a language" entry point, which all funnel through it)
//   * `ensureProjectLaneStmts` — the registry/settings/import-tag writer
//   * `ensureTargetLaneStmt` — ensure-lane-for-tag, for a server-side writer
//     about to put rows under a tag the project does not have yet
// and pins who does NOT gain the lane: a lane-scoped member, a Maintainer, and
// a role below Viewer.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  ensureProjectLaneStmts,
  ensureTargetLaneStmt,
  listProjectLanes,
} from "../../../db/shared/lanes"
import { grantNewLaneStmt } from "../../../db/shared/lane-grants"

const PROJECT = "p-grant"

/**
 * user 1 = owner (project creator, 700). The members below are the people the
 * read wall applies to:
 *   2 = contributor (400), unscoped — should gain every new lane
 *   3 = contributor (400), scoped to the French lane — should gain none
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

async function createLane(language: string): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/lanes`,
    {
      method: "POST",
      headers: authHeader(await jwtFor("owner")),
      body: JSON.stringify({ name: "", language }),
    },
    env,
  )
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

describe("AQU-1781 POST /lanes grants the new lane", () => {
  it("grants an unscoped member below Maintainer, at their project role level", async () => {
    const res = await createLane("Spanish")
    expect(res.status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect(await grantsFor(2)).toEqual([
      { lane: laneId, level: 400 },
      { lane: "ln-fr", level: 400 },
    ])
  })

  it("does not grant a lane-scoped member", async () => {
    expect((await createLane("Spanish")).status).toBe(201)
    expect(await grantsFor(3)).toEqual([{ lane: "ln-fr", level: 400 }])
  })

  it("grants nobody at or above Maintainer, or below Viewer", async () => {
    expect((await createLane("Spanish")).status).toBe(201)
    expect(await grantsFor(4)).toEqual([])
    expect(await grantsFor(5)).toEqual([])
  })

  it("grants only the lane being created, leaving an archived lane elsewhere as it was", async () => {
    // An archived lane an unscoped member already holds. Creating a lane must
    // neither re-grant it nor drop it — only the new lane moves.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ('ln-old', ?, 'target', 'Dutch', NULL, NULL, 'Dutch', 9)`,
    )
      .bind(PROJECT)
      .run()
    await env.AQUILLA_PG.prepare("UPDATE lanes SET archived_at = now() WHERE id = 'ln-old'").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, 2, 'ln-old', 400, 1)`,
    )
      .bind(PROJECT)
      .run()
    expect((await createLane("Spanish")).status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect((await grantsFor(2)).map((g) => g.lane).sort()).toEqual(
      [laneId, "ln-fr", "ln-old"].sort(),
    )
  })

  it("does not widen a member staffed onto one lane by grants alone (no scope row)", async () => {
    // AQU-730's leveled grants REPLACED kind='lane' scope rows, so a member
    // limited to one lane can hold a single grant and no scope row. Reading
    // "unscoped" off the scopes table alone would hand them every later lane.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ('ln-pt', ?, 'target', 'Portuguese', NULL, NULL, 'Portuguese', 9)`,
    )
      .bind(PROJECT)
      .run()
    // user 2 now holds French but not Portuguese: they are lane-limited.
    expect((await createLane("Spanish")).status).toBe(201)
    expect((await grantsFor(2)).map((g) => g.lane)).toEqual(["ln-fr"])
  })

  it("grants a member who holds no grants on a project that has no target lane yet", async () => {
    await env.AQUILLA_PG.prepare("DELETE FROM project_member_lane_roles WHERE project_id = ?")
      .bind(PROJECT)
      .run()
    await env.AQUILLA_PG.prepare(
      "DELETE FROM lanes WHERE project_id = ? AND role = 'target'",
    )
      .bind(PROJECT)
      .run()
    expect((await createLane("Spanish")).status).toBe(201)
    const laneId = await laneIdForTag("Spanish")
    expect((await grantsFor(2)).map((g) => g.lane)).toEqual([laneId])
  })

  it("writes no duplicate rows when the same language is asked for twice", async () => {
    expect((await createLane("Spanish")).status).toBe(201)
    // Same display name — refused as a duplicate, and nothing further is written.
    expect((await createLane("Spanish")).status).toBe(409)
    const laneId = await laneIdForTag("Spanish")
    expect(await grantsFor(2)).toEqual([
      { lane: laneId, level: 400 },
      { lane: "ln-fr", level: 400 },
    ])
  })
})

describe("AQU-1781 the server-side lane writers grant too", () => {
  it("ensureProjectLaneStmts grants a lane created for a tag found in the data", async () => {
    const stmts = ensureProjectLaneStmts(env.AQUILLA_PG, PROJECT, {
      lanes: [{ role: "target", language: "Swahili", legacyTag: "Swahili" }],
    })
    await env.AQUILLA_PG.batch(stmts)
    const laneId = await laneIdForTag("Swahili")
    expect((await grantsFor(2)).map((g) => g.lane).sort()).toEqual([laneId, "ln-fr"].sort())
    expect(await grantsFor(3)).toEqual([{ lane: "ln-fr", level: 400 }])
  })

  it("ensureTargetLaneStmt grants the lane it ensures, and re-running adds no rows", async () => {
    const run = () =>
      env.AQUILLA_PG.batch([
        ensureTargetLaneStmt(env.AQUILLA_PG, PROJECT, "Tshangla"),
        grantNewLaneStmt(env.AQUILLA_PG, PROJECT, { legacyTag: "Tshangla" }, null),
      ])
    await run()
    const laneId = await laneIdForTag("Tshangla")
    expect((await grantsFor(2)).map((g) => g.lane)).toContain(laneId)
    const before = await grantsFor(2)
    await run()
    expect(await grantsFor(2)).toEqual(before)
  })
})
