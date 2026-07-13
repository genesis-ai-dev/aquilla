/**
 * AQU-271 — File-delete gate: raised from contributor(400) to project_lead(500).
 *
 * Hard-deletes files rows and wipes all R2 audio; contributors must not be
 * able to destroy data they cannot recover.
 *
 * Characterization tests (flipping the AQU-268 pinned 400-level assumption):
 *   - contributor (400) → 403
 *   - project_lead (500) → 200 (no R2 in test env — DELETE completes against PG only)
 */

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedWorld() {
  await seedUser(1, "owner")
  await seedUser(2, "contributor_user")
  await seedUser(3, "lead_user")

  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Alpha', 1, 1)",
  ).run()

  // contributor_user (400) on proj1
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 400, 1)",
  ).run()
  // lead_user (500) on proj1
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 500, 1)",
  ).run()
  // Seed a file to delete
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, word_count, last_edit_at) VALUES ('f1', 'proj1', 'GEN', 'e1', 100, 40, 500, 1000)",
  ).run()
}

describe("AQU-271: file DELETE gate — project_lead(500)+ required", () => {
  beforeEach(async () => {
    await seedWorld()
  })

  it("contributor (400) is rejected with 403", async () => {
    const res = await app.request(
      "/api/v2/projects/proj1/files/f1",
      { method: "DELETE", headers: authHeader(await jwtFor("contributor_user")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("project_lead")
  })

  it("project_lead (500) is allowed (200)", async () => {
    const res = await app.request(
      "/api/v2/projects/proj1/files/f1",
      { method: "DELETE", headers: authHeader(await jwtFor("lead_user")) },
      env,
    )
    // 200 or 204 — R2 call is best-effort and skipped in test env
    expect(res.status).toBeLessThan(300)
  })

  it("unauthenticated request is rejected", async () => {
    const res = await app.request(
      "/api/v2/projects/proj1/files/f1",
      { method: "DELETE" },
      env,
    )
    expect(res.status).toBe(401)
  })
})
