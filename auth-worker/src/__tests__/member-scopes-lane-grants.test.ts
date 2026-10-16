// AQU-1783 — the member inspector's payload.
//
// The inspector used to read `project_member_scopes` and print "Unscoped —
// full access" when they were empty. The read wall reads a different table,
// `project_member_lane_roles`, so a member whose grants lag behind the lane
// set read none of it while the lead was told they read all of it.
//
// Pins:
//   * A project lead (500+) gets `laneAccess`: the member's grants (lane id,
//     NAME, level), the project's current non-archived target lanes, the
//     member's effective role, and whether this environment enforces the wall.
//   * A member below project_lead reading their OWN scopes gets no
//     `laneAccess` — the project's whole lane set is the sibling-lane leak
//     AQU-1421 closes.
//   * A project with no target lane rows keeps the plain `{ scopes }` shape.
//   * The regrant (an empty lane-scope PUT) grants every target lane, the
//     archived one included, and the PUT reports them back. Archived lanes
//     count because AQU-1781 grants a lane created later only to members who
//     already hold every other lane — so a lane created after the regrant
//     still reaches the member.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

interface LaneAccess {
  memberRoleLevel: number
  readWallEnabled: boolean
  grants: Array<{ laneId: string; name: string; level: number }>
  targetLanes: Array<{ id: string; name: string }>
}

// user 1 = owner (700), user 2 = carol (contributor 400), user 3 = lead (500),
// user 5 = mat (maintainer 600).
async function seedProject(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "carol")
  await seedUser(3, "lead")
  await seedUser(5, "mat")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-g', 'Grants', NULL, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('proj-g', 2, 400, 1), ('proj-g', 3, 500, 1), ('proj-g', 5, 600, 1)`,
  ).run()
}

/**
 * French and Spanish are current; Tagalog is archived, so it is never one of
 * the inspector's target lanes (though an unscoped member still holds it).
 */
async function seedLanes(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position, archived_at)
     VALUES ('lane-fr', 'proj-g', 'target', 'French',  NULL, '',   1, NULL),
            ('lane-es', 'proj-g', 'target', 'Spanish', NULL, 'es', 2, NULL),
            ('lane-tl', 'proj-g', 'target', 'Tagalog', NULL, 'tl', 3, '2026-09-01T00:00:00Z')`,
  ).run()
}

async function getScopes(jwt: string, userId: number | "me"): Promise<Response> {
  return app.request(
    `/api/v2/projects/proj-g/members/${userId}/scopes`,
    { method: "GET", headers: authHeader(jwt) },
    env,
  )
}

async function laneRolesFor(userId: number): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT lane FROM project_member_lane_roles WHERE project_id = 'proj-g' AND user_id = ? ORDER BY lane",
  )
    .bind(userId)
    .all<{ lane: string }>()
  return (rows.results ?? []).map((r) => r.lane)
}

beforeEach(async () => {
  await seedProject()
  env.LANE_READ_WALL = "1"
})
afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("AQU-1783 member-scopes GET — the inspector's grant payload", () => {
  it("reports the gap a lead needs to see: granted lanes, and the lane with no grant", async () => {
    await seedLanes()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('proj-g', 2, 'lane-fr', 400)",
    ).run()
    const res = await getScopes(await jwtFor("lead"), 2)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopes: unknown[]; laneAccess?: LaneAccess }
    // Scopes are empty — the old inspector called this "full access".
    expect(body.scopes).toEqual([])
    expect(body.laneAccess?.memberRoleLevel).toBe(400)
    expect(body.laneAccess?.readWallEnabled).toBe(true)
    // A grant is reported with its lane's NAME, never only its id.
    expect(body.laneAccess?.grants).toEqual([{ laneId: "lane-fr", name: "French", level: 400 }])
    // Current lanes only, in display order — the archived Tagalog lane is not one.
    expect(body.laneAccess?.targetLanes).toEqual([
      { id: "lane-fr", name: "French" },
      { id: "lane-es", name: "Spanish" },
    ])
  })

  it("reports no grants at all for the member whose grants were never written", async () => {
    await seedLanes()
    const res = await getScopes(await jwtFor("lead"), 2)
    const body = (await res.json()) as { laneAccess?: LaneAccess }
    expect(body.laneAccess?.grants).toEqual([])
    expect(body.laneAccess?.targetLanes).toHaveLength(2)
  })

  it("reports a maintainer's effective role, so the inspector can say 'visible by role'", async () => {
    await seedLanes()
    const res = await getScopes(await jwtFor("lead"), 5)
    const body = (await res.json()) as { laneAccess?: LaneAccess }
    expect(body.laneAccess?.memberRoleLevel).toBe(600)
  })

  it("says the wall is off where it is off, so no gap is reported as a problem", async () => {
    await seedLanes()
    env.LANE_READ_WALL = undefined
    const res = await getScopes(await jwtFor("lead"), 2)
    const body = (await res.json()) as { laneAccess?: LaneAccess }
    expect(body.laneAccess?.readWallEnabled).toBe(false)
  })

  it("does NOT hand the project's lane set to a member below project_lead", async () => {
    await seedLanes()
    const res = await getScopes(await jwtFor("carol"), 2)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopes: unknown[]; laneAccess?: LaneAccess }
    expect(body.laneAccess).toBeUndefined()
    expect(body.scopes).toEqual([])
  })

  it("omits laneAccess entirely when the project has no target lane rows", async () => {
    const res = await getScopes(await jwtFor("lead"), 2)
    expect(await res.json()).toEqual({ scopes: [] })
  })
})

describe("AQU-1783 member-scopes PUT — the one-click regrant", () => {
  it("an empty lane-scope set grants every target lane, the archived one included", async () => {
    await seedLanes()
    // Start from the broken state: one grant, two current lanes.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('proj-g', 2, 'lane-fr', 400)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/proj-g/members/2/scopes",
      {
        method: "PUT",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ scopes: [{ kind: "file", value: "f1" }] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    // Every lane is granted, archived Tagalog too: without it, AQU-1781 would
    // treat the member as limited and skip them for every lane created later.
    expect(await laneRolesFor(2)).toEqual(["lane-es", "lane-fr", "lane-tl"])
    // The response carries the refreshed grants, so the inspector's list can
    // update without a page reload. The inspector itself lists current lanes
    // only, so the archived grant does not show there.
    const body = (await res.json()) as { scopes: unknown[]; laneAccess?: LaneAccess }
    expect(body.laneAccess?.grants.map((g) => g.laneId).sort()).toEqual([
      "lane-es",
      "lane-fr",
      "lane-tl",
    ])
    expect(body.laneAccess?.targetLanes.map((lane) => lane.id)).toEqual(["lane-fr", "lane-es"])
    // The member's file scope is untouched by the lane regrant.
    expect(body.scopes).toEqual([{ kind: "file", value: "f1" }])
  })

  it("a lane created after the regrant still reaches the member", async () => {
    await seedLanes()
    const regrant = await app.request(
      "/api/v2/projects/proj-g/members/2/scopes",
      { method: "PUT", headers: authHeader(await jwtFor("lead")), body: JSON.stringify({ scopes: [] }) },
      env,
    )
    expect(regrant.status).toBe(200)
    const created = await app.request(
      "/api/v2/projects/proj-g/lanes",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ name: "", language: "German" }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const german = await env.AQUILLA_PG.prepare(
      "SELECT id FROM lanes WHERE project_id = 'proj-g' AND role = 'target' AND language = 'German'",
    ).first<{ id: string }>()
    expect(german).not.toBeNull()
    expect(await laneRolesFor(2)).toContain(german?.id)
  })

  it("a lane-scoped save still grants only that lane", async () => {
    await seedLanes()
    const res = await app.request(
      "/api/v2/projects/proj-g/members/2/scopes",
      {
        method: "PUT",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ scopes: [{ kind: "lane", value: "lane-es" }] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await laneRolesFor(2)).toEqual(["lane-es"])
    const body = (await res.json()) as { laneAccess?: LaneAccess }
    expect(body.laneAccess?.grants).toEqual([{ laneId: "lane-es", name: "Spanish", level: 400 }])
  })
})
