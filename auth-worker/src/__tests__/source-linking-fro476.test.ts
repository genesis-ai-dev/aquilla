// AQU-476: source-linking route extension tests (mode/consumes/gate persist,
// seeding trigger best-effort, detach clears link metadata).

import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProjectWithLead(projectId: string, name: string, leadUserId: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, name, leadUserId)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 500, ?)",
  )
    .bind(projectId, leadUserId, leadUserId)
    .run()
}

describe("POST /:projectId/link-source — AQU-476 mode/consumes/gate", () => {
  it("persists mode='live'/consumes/gate and triggers the seed sync (best-effort)", async () => {
    await seedUser(1, "lead")
    await seedProjectWithLead("proj-down", "Downstream", 1)
    await seedProjectWithLead("proj-up", "Upstream", 1)

    // Stub the outbound seed-sync fetch so the test doesn't need a live
    // sync-worker — triggerLinkSeedSync is best-effort and swallows errors,
    // but we still want to assert it WAS called with the right shape.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ranSync: true }), { status: 200 }))

    const res = await app.request(
      "/api/v2/projects/proj-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ sourceProjectId: "proj-up", mode: "live", consumes: "source", gate: "head" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { mode: string; consumes: string; gate: string }
    expect(body.mode).toBe("live")
    expect(body.consumes).toBe("source")
    expect(body.gate).toBe("head")

    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor FROM projects WHERE id = ?",
    )
      .bind("proj-down")
      .first<{
        source_project_id: string
        source_link_mode: string
        source_link_consumes: string
        source_link_gate: string
        source_link_cursor: number
      }>()
    expect(row?.source_project_id).toBe("proj-up")
    expect(row?.source_link_mode).toBe("live")
    expect(row?.source_link_consumes).toBe("source")
    expect(row?.source_link_gate).toBe("head")
    expect(Number(row?.source_link_cursor)).toBe(0)

    // Best-effort seed trigger fired a POST to the sync-worker's /link/sync route.
    expect(fetchSpy).toHaveBeenCalled()
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0])
    expect(calledUrl).toContain("/api/v1/projects/proj-down/link/sync")

    fetchSpy.mockRestore()
  })

  it("defaults mode to 'clone' when omitted (backward compatible) and does NOT trigger a seed sync", async () => {
    await seedUser(2, "lead2")
    await seedProjectWithLead("proj-down2", "Downstream2", 2)
    await seedProjectWithLead("proj-up2", "Upstream2", 2)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))

    const res = await app.request(
      "/api/v2/projects/proj-down2/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead2")),
        body: JSON.stringify({ sourceProjectId: "proj-up2" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { mode: string }
    expect(body.mode).toBe("clone")

    const row = await env.AQUILLA_PG.prepare("SELECT source_link_mode FROM projects WHERE id = ?")
      .bind("proj-down2")
      .first<{ source_link_mode: string }>()
    expect(row?.source_link_mode).toBe("clone")

    // No seed-sync call for clone mode.
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe("POST /:projectId/detach-source — AQU-476 clears link metadata", () => {
  it("clears mode/consumes/gate/cursor alongside source_project_id", async () => {
    await seedUser(3, "lead3")
    await seedProjectWithLead("proj-down3", "Downstream3", 3)
    await seedProjectWithLead("proj-up3", "Upstream3", 3)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    await app.request(
      "/api/v2/projects/proj-down3/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead3")),
        body: JSON.stringify({ sourceProjectId: "proj-up3", mode: "live" }),
      },
      env,
    )
    fetchSpy.mockRestore()

    // Seed the upstream + downstream cells so the detach's snapshot burst
    // (existing behavior, untouched) has something to copy — irrelevant to
    // this assertion but keeps the route's existing path exercised.
    const res = await app.request(
      "/api/v2/projects/proj-down3/detach-source",
      { method: "POST", headers: authHeader(await jwtFor("lead3")) },
      env,
    )
    expect(res.status).toBe(200)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor FROM projects WHERE id = ?",
    )
      .bind("proj-down3")
      .first<{
        source_project_id: string | null
        source_link_mode: string | null
        source_link_consumes: string | null
        source_link_gate: string | null
        source_link_cursor: number
      }>()
    expect(row?.source_project_id).toBeNull()
    expect(row?.source_link_mode).toBeNull()
    expect(row?.source_link_consumes).toBeNull()
    expect(row?.source_link_gate).toBeNull()
    expect(Number(row?.source_link_cursor)).toBe(0)
  })
})
