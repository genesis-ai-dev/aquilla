// AQU-1039: GET /api/v2/projects/:projectId/settings honors lane scopes even
// while LANE_READ_WALL is off (local and e2e). A contributor scoped to `es`
// is not handed `fr` or `de`. An unscoped member still receives the full
// registry — that case is the wall-off default, not this file.
//
// A project lead is below the read wall. A leftover lane scope limits them
// the same way it limits a contributor, wall on or off. A lead with no grant
// and no scope sees every lane only while the wall is off.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const FULL_REGISTRY = ["fr", "es", "de"]

/** carla (400) and lena (500) both carry a lane scope on `es`. */
async function seedScopedMembers(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "carla")
  await seedUser(3, "lena")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'Lanes', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 2, 400), ('p1', 3, 500)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify({ sourceLanguage: "en", targetLanes: FULL_REGISTRY }))
    .run()
  // No lane rows: the stored scope value is the tag. Settings still drop the
  // other labels. A filled `language` column is not required.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at)
     VALUES ('p1', 2, 'lane', 'es', 0), ('p1', 3, 'lane', 'es', 0)`,
  ).run()
}

async function targetLanes(username: string): Promise<string[] | undefined> {
  const res = await app.request(
    "/api/v2/projects/p1/settings",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { settings: { targetLanes?: string[] } }
  return body.settings.targetLanes
}

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("AQU-1039 — GET project settings hides lanes outside a member's scope", () => {
  it("returns only the scoped lane to a lane-scoped contributor", async () => {
    await seedScopedMembers()
    expect(await targetLanes("carla")).toEqual(["es"])
  })

  it("limits a project lead with a leftover scope to that lane when the wall is off", async () => {
    await seedScopedMembers()
    expect(await targetLanes("lena")).toEqual(["es"])
    env.LANE_READ_WALL = "1"
    // No grant rows: the wall hides every target lane. The leftover scope does
    // not open one.
    expect(await targetLanes("lena")).toEqual([])
  })
})

/**
 * With lane rows a stored scope is a lane id (AQU-1607), or a tag the batch
 * backfill has not converted yet. French is the default lane. dan (500) and
 * carla (400) hold a grant on Spanish only and carry a leftover scope on it;
 * erin (500) holds neither. The wall hides French and German from carla and
 * hides them from both leads: dan is granted Spanish, erin holds no grant.
 */
const STORED = {
  sourceLanguage: "English",
  targetLanguage: "French",
  targetLanes: ["de", "es"],
  archivedLanes: [],
}

async function seedLaneRows(scopeValue: string): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(3, "carla")
  await seedUser(4, "dan")
  await seedUser(5, "erin")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Psalms', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 3, 400, 1), ('p1', 4, 500, 1), ('p1', 5, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', 'p1', 'source', 'English', 'en', NULL, 0),
      ('ln-main', 'p1', 'target', 'French', 'fr', '', 1),
      ('ln-de', 'p1', 'target', 'German', 'de', 'de', 2),
      ('ln-es', 'p1', 'target', 'Spanish', 'es', 'es', 3)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level)
     VALUES ('p1', 4, 'ln-es', 500), ('p1', 3, 'ln-es', 400)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at)
     VALUES ('p1', 4, 'lane', ?, 0), ('p1', 3, 'lane', ?, 0)`,
  )
    .bind(scopeValue, scopeValue)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(STORED))
    .run()
}

interface SettingsBody {
  settings: Record<string, unknown>
  lanes?: Array<{ id: string; role: string }>
}

/** The three things the filter touches: the primary, the registry, the lane rows. */
async function laneView(username: string) {
  const res = await app.request(
    "/api/v2/projects/p1/settings",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as SettingsBody
  return {
    targetLanguage: body.settings.targetLanguage,
    targetLanes: body.settings.targetLanes,
    laneIds: (body.lanes ?? [])
      .filter((lane) => lane.role === "target")
      .map((lane) => lane.id)
      .sort(),
  }
}

const EVERY_LANE = {
  targetLanguage: "French",
  targetLanes: ["de", "es"],
  laneIds: ["ln-de", "ln-es", "ln-main"],
}
const SPANISH_ONLY = { targetLanguage: "", targetLanes: ["es"], laneIds: ["ln-es"] }
const NO_TARGET = { targetLanguage: "", targetLanes: [], laneIds: [] }

describe.each([
  ["a lane id", "ln-es"],
  ["an unconverted tag", "es"],
])("a project lead whose leftover scope is %s", (_label, scopeValue) => {
  it("sees only a grant with the wall on", async () => {
    await seedLaneRows(scopeValue)
    env.LANE_READ_WALL = "1"
    expect(await laneView("erin")).toEqual(NO_TARGET)
    expect(await laneView("carla")).toEqual(SPANISH_ONLY)
    expect(await laneView("dan")).toEqual(SPANISH_ONLY)
  })

  it("sees only the scope with the wall off", async () => {
    await seedLaneRows(scopeValue)
    expect(await laneView("erin")).toEqual(EVERY_LANE)
    expect(await laneView("carla")).toEqual(SPANISH_ONLY)
    expect(await laneView("dan")).toEqual(SPANISH_ONLY)
  })
})
