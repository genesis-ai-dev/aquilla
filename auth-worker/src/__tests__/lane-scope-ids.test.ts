// AQU-1607: a lane scope is a lane id, not a language tag.
//
// Pins:
//   * PUT member scopes stores `lanes.id`, and converts a legacy tag that
//     names exactly one lane — including `''` for the former default lane,
//     so no new `''` row is written.
//   * A tag naming two lanes of one language, or no lane, is refused rather
//     than guessed, and nothing is written.
//   * An invite minted with a lane id grants exactly that lane on accept —
//     the same-language sibling gets neither a scope row nor a grant.
//   * A project whose lanes table has no rows yet keeps the pre-lane-id
//     behaviour (store what the caller sent) so this lands ahead of the
//     AQU-1616 backfill.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** user 1 = owner (700), user 2 = contributor (400). */
async function seedProject(id: string, withLanes: boolean): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 1)",
  )
    .bind(id, `Project ${id}`)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 1)",
  )
    .bind(id)
    .run()
  if (!withLanes) return
  // Two Spanish lanes — the former default lane and a second one carrying
  // the language as its tag, which is what a project that added a lane for
  // the language it already had looks like. "Spanish" therefore names both.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', ?, 'source', 'Greek', 'el', NULL, 0),
      ('ln-main', ?, 'target', 'Spanish', 'es', '', 1),
      ('ln-mx', ?, 'target', 'Spanish', 'es', 'Spanish', 2),
      ('ln-pe', ?, 'target', 'Spanish — Peru', 'es', 'es-PE', 3)`,
  )
    .bind(id, id, id, id)
    .run()
}

async function putScopes(
  projectId: string,
  jwt: string,
  scopes: Array<{ kind: string; value: string }>,
): Promise<Response> {
  return app.request(
    `/api/v2/projects/${projectId}/members/2/scopes`,
    { method: "PUT", headers: authHeader(jwt), body: JSON.stringify({ scopes }) },
    env,
  )
}

async function storedLaneScopes(projectId: string, userId: number): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT value FROM project_member_scopes WHERE project_id = ? AND user_id = ? AND kind = 'lane' ORDER BY value",
  )
    .bind(projectId, userId)
    .all<{ value: string }>()
  return (rows.results ?? []).map((r) => r.value)
}

async function storedLaneGrants(projectId: string, userId: number): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT lane FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? ORDER BY lane",
  )
    .bind(projectId, userId)
    .all<{ lane: string }>()
  return (rows.results ?? []).map((r) => r.lane)
}

beforeEach(async () => {
  await seedUser(1, "owner")
  await seedUser(2, "carol")
})

describe("AQU-1607 member scopes store lane ids", () => {
  beforeEach(async () => {
    await seedProject("p-lanes", true)
  })

  it("stores a lane id as given", async () => {
    const res = await putScopes("p-lanes", await jwtFor("owner"), [{ kind: "lane", value: "ln-mx" }])
    expect(res.status).toBe(200)
    expect(await storedLaneScopes("p-lanes", 2)).toEqual(["ln-mx"])
  })

  it("converts the former default lane's '' tag to that lane's id", async () => {
    const res = await putScopes("p-lanes", await jwtFor("owner"), [{ kind: "lane", value: "" }])
    expect(res.status).toBe(200)
    expect(await storedLaneScopes("p-lanes", 2)).toEqual(["ln-main"])
  })

  it("converts a tag that names exactly one lane", async () => {
    const res = await putScopes("p-lanes", await jwtFor("owner"), [
      { kind: "lane", value: "es-PE" },
      { kind: "file", value: "f1" },
    ])
    expect(res.status).toBe(200)
    // The response also names the lane, so a chip can read as a lane.
    expect(await res.json()).toEqual({
      scopes: [
        { kind: "file", value: "f1" },
        { kind: "lane", value: "ln-pe" },
      ],
      laneNames: { "ln-pe": "Spanish — Peru" },
    })
  })

  it("refuses a tag that names two lanes of one language, writing nothing", async () => {
    const owner = await jwtFor("owner")
    expect((await putScopes("p-lanes", owner, [{ kind: "lane", value: "ln-mx" }])).status).toBe(200)
    const res = await putScopes("p-lanes", owner, [{ kind: "lane", value: "Spanish" }])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ambiguous: ["Spanish"] })
    // The refused PUT left the previous scope alone — it is not a clear.
    expect(await storedLaneScopes("p-lanes", 2)).toEqual(["ln-mx"])
  })

  it("refuses a value that names no lane of this project", async () => {
    const res = await putScopes("p-lanes", await jwtFor("owner"), [{ kind: "lane", value: "de" }])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ unmatched: ["de"] })
    expect(await storedLaneScopes("p-lanes", 2)).toEqual([])
  })

  it("still clears every scope with an empty replace-set", async () => {
    const owner = await jwtFor("owner")
    expect((await putScopes("p-lanes", owner, [{ kind: "lane", value: "ln-mx" }])).status).toBe(200)
    expect((await putScopes("p-lanes", owner, [])).status).toBe(200)
    expect(await storedLaneScopes("p-lanes", 2)).toEqual([])
  })
})

describe("AQU-1607 member scopes on a project with no lane rows", () => {
  it("stores what the caller sent (pre-backfill projects keep working)", async () => {
    await seedProject("p-bare", false)
    const res = await putScopes("p-bare", await jwtFor("owner"), [{ kind: "lane", value: "es" }])
    expect(res.status).toBe(200)
    expect(await storedLaneScopes("p-bare", 2)).toEqual(["es"])
  })
})

describe("AQU-1607 invites carry lane ids", () => {
  beforeEach(async () => {
    await seedProject("p-inv", true)
  })

  it("grants exactly the invited lane, never its same-language sibling", async () => {
    await seedUser(3, "bob")
    const created = await app.request(
      "/api/v2/projects/p-inv/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ role: 400, scopeLanes: ["ln-mx"] }),
      },
      env,
    )
    expect(created.status).toBe(200)
    const { token, scopeLanes } = (await created.json()) as { token: string; scopeLanes?: string[] }
    expect(scopeLanes).toEqual(["ln-mx"])

    const accepted = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ token }),
      },
      env,
    )
    expect(accepted.status).toBe(200)
    expect(await storedLaneScopes("p-inv", 3)).toEqual(["ln-mx"])
    expect(await storedLaneGrants("p-inv", 3)).toEqual(["ln-mx"])
  })

  it("refuses to mint a link whose lane names two lanes of one language", async () => {
    const res = await app.request(
      "/api/v2/projects/p-inv/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ role: 400, scopeLanes: ["Spanish"] }),
      },
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ambiguous: ["Spanish"] })
  })

  it("converts a single-lane tag when minting", async () => {
    const res = await app.request(
      "/api/v2/projects/p-inv/invites",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ role: 400, scopeLanes: ["es-PE"] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ scopeLanes: ["ln-pe"] })
  })
})
