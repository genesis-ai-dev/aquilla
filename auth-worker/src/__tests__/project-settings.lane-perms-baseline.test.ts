// AQU-1039: GET /api/v2/projects/:projectId/settings honors lane scopes even
// while LANE_READ_WALL is off (local and e2e). A contributor scoped to `es`
// is not handed `fr` or `de`. An unscoped member still receives the full
// registry — that case is the wall-off default, not this file.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const FULL_REGISTRY = ["fr", "es", "de"]

async function seedScopedContributor(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "carla")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'Lanes', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 2, 400)",
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
     VALUES ('p1', 2, 'lane', 'es', 0)`,
  ).run()
}

describe("AQU-1039 — GET project settings hides lanes outside a member's scope", () => {
  it("returns only the scoped lane to a lane-scoped contributor", async () => {
    await seedScopedContributor()
    const res = await app.request(
      "/api/v2/projects/p1/settings",
      { headers: authHeader(await jwtFor("carla")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { targetLanes?: string[] } }
    expect(body.settings.targetLanes).toEqual(["es"])
  })
})
