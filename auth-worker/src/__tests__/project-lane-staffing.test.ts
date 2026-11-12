// AQU-1994 — GET /api/v2/projects/:projectId/lane-staffing.
//
// Every Assign surface on the project overview offers the project's own target
// lanes (AQU-1977). That list includes lanes nobody on the project can work
// in: the reported project had French, Mandarin Chinese and Swedish but its
// team was only on Mandarin Chinese, and the field listed all three, so a
// manager could route French work to people with no access to French.
//
// This route answers which of the project's CURRENT target lanes at least one
// of its people holds a grant on at Contributor (400) or above. Pins:
//   * a direct lane grant staffs its lane, and only its lane;
//   * a lane reached only through an attached org Team counts — the team paths
//     write the same `project_member_lane_roles` rows (AQU-1801 / AQU-1813);
//   * a Maintainer who reads every lane through their ROLE staffs none of
//     them: being able to read a language is not being staffed on it;
//   * a grant below Contributor does not staff a lane;
//   * a grant left behind by someone no longer on the project is ignored;
//   * an archived lane is never reported;
//   * a project with no target lane rows answers with NOTHING, not an empty
//     list — the client must read that as "the server did not say" and keep
//     offering what it offers today;
//   * below project lead the answer is refused: who is staffed where is
//     roster information.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const VIEWER = 100
const CONTRIBUTOR = 400
const PROJECT_LEAD = 500
const MAINTAINER = 600

/**
 * user 1 = alice, org owner and project creator.
 * user 2 = zhen, contributor — the person on Mandarin Chinese.
 * user 3 = mat, maintainer with no grant row.
 * user 4 = gone, a contributor whose membership row was removed.
 * user 5 = carol, an org viewer who only ever reaches p1 through Team T.
 */
async function seedProject(opts: { lanes?: boolean } = {}): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "zhen")
  await seedUser(3, "mat")
  await seedUser(4, "gone")
  await seedUser(5, "carol")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alice Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (1, 1, 700, 1), (1, 5, ?, 1)`,
  )
    .bind(VIEWER)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Trilingual', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 2, ?, 1), ('p1', 3, ?, 1)`,
  )
    .bind(CONTRIBUTOR, MAINTAINER)
    .run()
  if (opts.lanes === false) return
  // Swedish is archived, so it is never one of the project's current lanes.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position, archived_at) VALUES
       ('src00001', 'p1', 'source', 'English', NULL, NULL, 0, NULL),
       ('lane-fr',  'p1', 'target', 'French',  NULL, 'fr', 1, NULL),
       ('lane-zh',  'p1', 'target', 'Mandarin Chinese', NULL, 'zh', 2, NULL),
       ('lane-sv',  'p1', 'target', 'Swedish', NULL, 'sv', 3, '2026-09-01T00:00:00Z')`,
  ).run()
}

async function grant(userId: number, lane: string, level = CONTRIBUTOR): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
     VALUES ('p1', ?, ?, ?, 1)`,
  )
    .bind(userId, lane, level)
    .run()
}

async function staffing(username = "alice"): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/lane-staffing",
    { method: "GET", headers: authHeader(await jwtFor(username)) },
    env,
  )
}

async function laneIdsFor(username = "alice"): Promise<string[] | undefined> {
  const res = await staffing(username)
  expect(res.status).toBe(200)
  return ((await res.json()) as { laneIds?: string[] }).laneIds
}

describe("project lane staffing (AQU-1994)", () => {
  it("reports only the lane the project's one contributor is on", async () => {
    await seedProject()
    await grant(2, "lane-zh")

    expect(await laneIdsFor()).toEqual(["lane-zh"])
  })

  it("adds a lane once someone holds a grant on it, in the project's lane order", async () => {
    await seedProject()
    await grant(2, "lane-zh")
    await grant(2, "lane-fr")

    expect(await laneIdsFor()).toEqual(["lane-fr", "lane-zh"])
  })

  it("does not let a Maintainer's role staff every lane", async () => {
    await seedProject()
    // user 3 is a Maintainer and reads every lane through the wall's role
    // cascade, but holds no grant row. Nobody else is on a lane either.
    expect(await laneIdsFor()).toEqual([])
  })

  it("ignores a grant below Contributor", async () => {
    await seedProject()
    await grant(2, "lane-fr", VIEWER)

    expect(await laneIdsFor()).toEqual([])
  })

  it("ignores a grant left behind by someone no longer on the project", async () => {
    await seedProject()
    // `gone` has a grant row but no project_members row — removing a member
    // deletes only the membership, so the grant rows survive.
    await grant(4, "lane-fr")

    expect(await laneIdsFor()).toEqual([])
  })

  it("never reports an archived lane", async () => {
    await seedProject()
    await grant(2, "lane-sv")
    await grant(2, "lane-zh")

    expect(await laneIdsFor()).toEqual(["lane-zh"])
  })

  it("counts a lane reached only through an attached org Team", async () => {
    await seedProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'Team T', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id, added_by) VALUES (1, 5, 1)",
    ).run()

    // The real attach path, with only Mandarin Chinese ticked: it writes
    // carol's grants, and carol reaches p1 through the team alone.
    const attach = await app.request(
      "/api/v2/orgs/1/groups/1/projects",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ projectId: "p1", roleLevel: CONTRIBUTOR, laneIds: ["lane-zh"] }),
      },
      env,
    )
    expect(attach.status).toBe(200)

    expect(await laneIdsFor()).toEqual(["lane-zh"])

    // Ticking Swedish too widens the staffed set through the same path.
    const retick = await app.request(
      "/api/v2/orgs/1/groups/1/projects/p1",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ laneIds: ["lane-zh", "lane-fr"] }),
      },
      env,
    )
    expect(retick.status).toBe(200)

    expect(await laneIdsFor()).toEqual(["lane-fr", "lane-zh"])
  })

  it("says nothing about staffing on a project with no target lane rows", async () => {
    await seedProject({ lanes: false })

    const res = await staffing()
    expect(res.status).toBe(200)
    // No `laneIds` key: the client reads that as "unknown" and keeps its
    // current list, rather than narrowing to nothing. `teamLanes` is still
    // answered — here there is no attached team, which is not "no lanes".
    expect(await res.json()).toEqual({ teamLanes: [] })
  })

  it("refuses a caller below project lead", async () => {
    await seedProject()
    await grant(2, "lane-zh")

    expect((await staffing("zhen")).status).toBe(403)
  })

  it("answers a project lead", async () => {
    await seedProject()
    await env.AQUILLA_PG.prepare(
      "UPDATE project_members SET role_level = ? WHERE project_id = 'p1' AND user_id = 2",
    )
      .bind(PROJECT_LEAD)
      .run()
    await grant(3, "lane-fr")

    expect(await laneIdsFor("zhen")).toEqual(["lane-fr"])
  })

  it("refuses someone with no access to the project at all", async () => {
    await seedProject()

    expect((await staffing("gone")).status).toBe(403)
  })
})

/**
 * AQU-2047 — the same read tells Assign work which lanes each attached team
 * is tied to. Staffing stays its own field: a team can check French while
 * the only person on the project is on Mandarin Chinese.
 */
describe("project team lane attachments (AQU-2047)", () => {
  async function attach(
    groupId: number,
    name: string,
    explicit: boolean,
    laneIds: string[] = [],
  ): Promise<void> {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (?, 1, ?, 1)",
    )
      .bind(groupId, name)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO group_project_grants
         (group_id, project_id, role_level, granted_by, lanes_explicit)
       VALUES (?, 'p1', ?, 1, ?)`,
    )
      .bind(groupId, CONTRIBUTOR, explicit)
      .run()
    for (const laneId of laneIds) {
      await env.AQUILLA_PG.prepare(
        "INSERT INTO group_project_lanes (group_id, project_id, lane_id) VALUES (?, 'p1', ?)",
      )
        .bind(groupId, laneId)
        .run()
    }
  }

  async function body(username = "alice"): Promise<{
    laneIds?: string[]
    teamLanes: { lanesExplicit: boolean; laneIds?: string[] }[]
  }> {
    const res = await staffing(username)
    expect(res.status).toBe(200)
    return (await res.json()) as {
      laneIds?: string[]
      teamLanes: { lanesExplicit: boolean; laneIds?: string[] }[]
    }
  }

  it("names the one lane an explicit team checked, and not the lanes it did not", async () => {
    await seedProject()
    await grant(2, "lane-zh")
    await attach(1, "Team T", true, ["lane-fr"])

    const read = await body()
    // Staffing is untouched: Zhen is on Mandarin Chinese, the team checked French.
    expect(read.laneIds).toEqual(["lane-zh"])
    expect(read.teamLanes).toEqual([{ lanesExplicit: true, laneIds: ["lane-fr"] }])
  })

  it("reports a team that has not saved checkboxes without a lane list", async () => {
    await seedProject()
    await attach(1, "Team T", false)
    // A row left behind must not become the set. lanes_explicit false means
    // every current target lane, until someone saves the checkboxes.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_lanes (group_id, project_id, lane_id) VALUES (1, 'p1', 'lane-fr')",
    ).run()

    const read = await body()
    expect(read.teamLanes).toEqual([{ lanesExplicit: false }])
    expect(read.teamLanes[0]).not.toHaveProperty("laneIds")
  })

  it("reports no attached team as an empty list", async () => {
    await seedProject()

    expect((await body()).teamLanes).toEqual([])
  })

  it("returns each explicit team on its own, ordered by group, for the client to union", async () => {
    await seedProject()
    await attach(2, "Team B", true, ["lane-sv"])
    await attach(1, "Team A", true, ["lane-fr"])

    expect((await body()).teamLanes).toEqual([
      { lanesExplicit: true, laneIds: ["lane-fr"] },
      { lanesExplicit: true, laneIds: ["lane-sv"] },
    ])
  })
})
