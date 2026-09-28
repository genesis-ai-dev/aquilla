// AQU-730 slice 0 — PRE-metadata-wall characterization baseline for GET
// /api/v2/projects/:projectId/settings.
//
// These tests pin TODAY'S behavior: any project member receives the FULL
// targetLanes registry regardless of project_member_scopes lane restrictions.
// When metadata isolation lands (design §2), scoped members will see only
// granted lanes — update this file deliberately; do not delete silently.
//
// See: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §2.

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
  // Lane scope restricts writes on the sync-worker; settings GET is not filtered today.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at)
     VALUES ('p1', 2, 'lane', 'es', 0)`,
  ).run()
}

describe("AQU-730 baseline — GET project settings metadata wall", () => {
  it("returns the full targetLanes registry to a lane-scoped contributor", async () => {
    await seedScopedContributor()
    const res = await app.request(
      "/api/v2/projects/p1/settings",
      { headers: authHeader(await jwtFor("carla")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { targetLanes?: string[] } }
    expect(body.settings.targetLanes).toEqual(FULL_REGISTRY)
  })
})
