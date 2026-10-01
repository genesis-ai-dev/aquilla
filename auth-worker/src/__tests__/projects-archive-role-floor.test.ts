import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/**
 * AQU-1070: archiving a project is the lever a partner uses to drop a finished
 * language out of its active-lane billing band, and it is reversible. It
 * therefore sits at maintainer+ (600) with the people who run the portfolio,
 * not at owner-only (700) where it started.
 */
describe("project archive/restore role floor (AQU-1070)", () => {
  beforeEach(async () => {
    await seedUser(1, "owner")
    await seedUser(2, "maintainer")
    await seedUser(3, "lead")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Luke', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 2, 600, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 3, 500, 1)",
    ).run()
  })

  /**
   * The archive routes push a tombstone to sync-worker off `executionCtx.waitUntil`,
   * and Hono throws when a request arrives without a ctx. Supply a stub so the
   * route exercises its real success path (the notify helper itself no-ops
   * without SYNC_WORKER_URL and swallows its own errors).
   */
  function ctx(): ExecutionContext {
    return { waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}), passThroughOnException: () => {} } as ExecutionContext
  }

  async function archivedAt(): Promise<string | null> {
    const row = await env.AQUILLA_PG.prepare("SELECT archived_at FROM projects WHERE id = 'p1'")
      .first<{ archived_at: string | null }>()
    return row?.archived_at ?? null
  }

  it("lets a maintainer archive and then restore the project", async () => {
    const headers = authHeader(await jwtFor("maintainer"))
    const archive = await app.request("/api/v2/projects/p1/archive", { method: "POST", headers }, env, ctx())
    expect(archive.status).toBe(200)
    expect(await archivedAt()).toBeTruthy()

    const restore = await app.request("/api/v2/projects/p1/archive", { method: "DELETE", headers }, env, ctx())
    expect(restore.status).toBe(200)
    expect(await archivedAt()).toBeNull()
  })

  it("still refuses a project_lead (500) — the floor moved to maintainer, not below it", async () => {
    const headers = authHeader(await jwtFor("lead"))
    const archive = await app.request("/api/v2/projects/p1/archive", { method: "POST", headers }, env, ctx())
    expect(archive.status).toBe(403)
    expect(((await archive.json()) as { error: string }).error).toMatch(/maintainer/i)
    expect(await archivedAt()).toBeNull()

    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET archived_at = CURRENT_TIMESTAMP, archived_by = 1 WHERE id = 'p1'",
    ).run()
    const restore = await app.request("/api/v2/projects/p1/archive", { method: "DELETE", headers }, env, ctx())
    expect(restore.status).toBe(403)
    expect(await archivedAt()).toBeTruthy()
  })

  it("keeps owners able to archive", async () => {
    const headers = authHeader(await jwtFor("owner"))
    const archive = await app.request("/api/v2/projects/p1/archive", { method: "POST", headers }, env, ctx())
    expect(archive.status).toBe(200)
    expect(await archivedAt()).toBeTruthy()
  })
})
