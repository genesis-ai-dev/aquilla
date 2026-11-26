/**
 * POST /api/v2/projects takes a client-chosen id. AQU-2357 made the create
 * write the creator's Owner grant in the same batch as the project insert, and
 * the project insert is `ON CONFLICT(id) DO NOTHING`. If the grant and the lane
 * writes run whether or not the project row was inserted, anyone who knows an
 * existing project's id can POST it and become that project's Owner (or raise
 * their own lower grant to Owner), and can add lanes to it.
 *
 * Why it matters: a project id is not a secret — it is in every URL, share
 * link and invite. Creating a project must never grant anything on a project
 * the caller did not just create.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { FIXTURE_USERS, seedAccessFixture } from "./helpers/access-fixture"
import { RESOLVER_MODES, count, req, sql } from "./helpers/attack"

const P1 = "p1" // fixture org 1, created by `owner` (user 1)

async function memberLevel(projectId: string, userId: number): Promise<number | null> {
  const n = await count(
    "SELECT COALESCE(MAX(role_level), -1) AS n FROM project_members WHERE project_id = ? AND user_id = ?",
    projectId,
    userId,
  )
  return n < 0 ? null : n
}

async function laneCount(projectId: string): Promise<number> {
  return count("SELECT count(*) AS n FROM lanes WHERE project_id = ?", projectId)
}

beforeEach(async () => {
  await seedAccessFixture()
})

describe.each(RESOLVER_MODES)("POST /projects with an id that already exists (resolver %s)", (mode) => {
  it("an outsider who reuses another user's project id gets 409 and no grant", async () => {
    const lanesBefore = await laneCount(P1)
    const res = await req(mode, "personal", "/api/v2/projects", {
      method: "POST",
      body: { id: P1, name: "Hijack" },
    })
    expect(await memberLevel(P1, FIXTURE_USERS.personal)).toBeNull()
    expect(await laneCount(P1)).toBe(lanesBefore)
    expect(res.status).toBe(409)
    expect(await count("SELECT count(*) AS n FROM projects WHERE id = ? AND name = 'Alpha'", P1)).toBe(1)
  })

  it("a Contributor on the project cannot raise its own grant to Owner by re-creating it", async () => {
    expect(await memberLevel(P1, FIXTURE_USERS.direct_below)).toBe(300)
    const res = await req(mode, "direct_below", "/api/v2/projects", {
      method: "POST",
      body: { id: P1, name: "Hijack" },
    })
    expect(await memberLevel(P1, FIXTURE_USERS.direct_below)).toBe(300)
    expect(res.status).toBe(409)
  })

  it("a lower existing grant is not raised even when the caller adds lanes in the request", async () => {
    // Lanes are seeded by the shared create; a collision must add none.
    await sql("INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES ('aaaaaaaa', ?, 'source', 'en', NULL, 0)", P1)
    const res = await req(mode, "direct_below", "/api/v2/projects", {
      method: "POST",
      body: { id: P1, name: "Hijack" },
    })
    expect(await laneCount(P1)).toBe(1)
    expect(res.status).toBe(409)
  })

  it("the creator's own retry of a create that already landed is a 200 and writes nothing new", async () => {
    const first = await req(mode, "personal", "/api/v2/projects", {
      method: "POST",
      body: { id: "mine", name: "Mine" },
    })
    expect(first.status).toBe(200)
    expect(await memberLevel("mine", FIXTURE_USERS.personal)).toBe(700)
    const lanes = await laneCount("mine")

    const retry = await req(mode, "personal", "/api/v2/projects", {
      method: "POST",
      body: { id: "mine", name: "Mine" },
    })
    expect(retry.status).toBe(200)
    expect(await memberLevel("mine", FIXTURE_USERS.personal)).toBe(700)
    expect(await laneCount("mine")).toBe(lanes)
  })

  it("a creator an Owner later demoted does not get Owner back by re-posting the create", async () => {
    // created_by is history only (AQU-2357): it must not act as a standing grant.
    await req(mode, "personal", "/api/v2/projects", { method: "POST", body: { id: "mine", name: "Mine" } })
    await sql("UPDATE project_members SET role_level = 300 WHERE project_id = 'mine' AND user_id = ?", FIXTURE_USERS.personal)

    await req(mode, "personal", "/api/v2/projects", { method: "POST", body: { id: "mine", name: "Mine" } })
    expect(await memberLevel("mine", FIXTURE_USERS.personal)).toBe(300)
  })
})
