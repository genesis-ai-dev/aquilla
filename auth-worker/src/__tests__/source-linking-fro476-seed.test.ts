// QA-BUG-1 (2026-07-06 live-UI QA, docs/swarm/LINKEDPROJ-UIQA.md): linked
// projects were born with 0 files/0 cells — the lazy-pull trigger
// (useStaleSourceCells) can't self-heal a project with no open file, and
// clone links never sync again after creation. This file proves both modes
// now seed synchronously inside the link-source route:
//   - mode='clone': snapshotSourceCells (already used by detach) now also
//     runs at link time and copies `files` rows, not just `cells` — the
//     detach path had the same files-are-dropped bug, fixed at the shared
//     helper (snapshotSourceFiles).
//   - mode='live': triggerLinkSeedSync is awaited by the route (previously
//     fire-and-forget-shaped but already awaited at the call site — this
//     suite additionally asserts the `seeded` response field reflects
//     success/failure so the client knows whether to self-heal).

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

async function seedUpstreamContent(projectId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at)
     VALUES ('f1', ?, 'qa-source-a.vtt', 'timed', 'e-file1', 1000, 1000)`,
  )
    .bind(projectId)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at) VALUES
       (?, 'f1', 'c1', 'source', 'Hello', 'e-c1', 1000),
       (?, 'f1', 'c2', 'source', 'World', 'e-c2', 1000)`,
  )
    .bind(projectId, projectId)
    .run()
}

describe("POST /:projectId/link-source — QA-BUG-1 clone-mode seeds at birth", () => {
  it("clone: copies upstream files AND cells synchronously, no later resync needed", async () => {
    await seedUser(10, "lead-clone")
    await seedProjectWithLead("proj-clone-up", "Upstream", 10)
    await seedProjectWithLead("proj-clone-down", "Downstream", 10)
    await seedUpstreamContent("proj-clone-up")

    const res = await app.request(
      "/api/v2/projects/proj-clone-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-clone")),
        body: JSON.stringify({ sourceProjectId: "proj-clone-up", mode: "clone" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { seeded: boolean; mode: string }
    expect(body.mode).toBe("clone")
    expect(body.seeded).toBe(true)

    const files = await env.AQUILLA_PG.prepare(
      "SELECT id, name FROM files WHERE project_id = ?",
    )
      .bind("proj-clone-down")
      .all<{ id: string; name: string }>()
    expect(files.results?.length).toBe(1)
    expect(files.results?.[0]?.name).toBe("qa-source-a.vtt")

    const cells = await env.AQUILLA_PG.prepare(
      "SELECT cell_id, value FROM cells WHERE project_id = ? AND side = 'source' ORDER BY cell_id",
    )
      .bind("proj-clone-down")
      .all<{ cell_id: string; value: string }>()
    expect(cells.results?.length).toBe(2)
    expect(cells.results?.map((c) => c.value)).toEqual(["Hello", "World"])
  })

  it("clone: an upstream with 0 files/cells reports seeded=false (nothing to copy) without erroring", async () => {
    await seedUser(11, "lead-empty")
    await seedProjectWithLead("proj-empty-up", "EmptyUpstream", 11)
    await seedProjectWithLead("proj-empty-down", "EmptyDownstream", 11)

    const res = await app.request(
      "/api/v2/projects/proj-empty-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-empty")),
        body: JSON.stringify({ sourceProjectId: "proj-empty-up", mode: "clone" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { seeded: boolean }
    expect(body.seeded).toBe(false)
  })
})

describe("POST /:projectId/link-source — QA-BUG-1 live-mode seeded flag", () => {
  it("live: seeded=true when the sync-worker trigger responds 2xx", async () => {
    await seedUser(12, "lead-live-ok")
    await seedProjectWithLead("proj-live-ok-up", "Upstream", 12)
    await seedProjectWithLead("proj-live-ok-down", "Downstream", 12)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ranSync: true, cellsMirrored: 2, filesMirrored: 1 }), { status: 200 }),
    )

    const res = await app.request(
      "/api/v2/projects/proj-live-ok-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-live-ok")),
        body: JSON.stringify({ sourceProjectId: "proj-live-ok-up", mode: "live" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { seeded: boolean }
    expect(body.seeded).toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("live: seeded=false when the sync-worker trigger fails — client can self-heal", async () => {
    await seedUser(13, "lead-live-fail")
    await seedProjectWithLead("proj-live-fail-up", "Upstream", 13)
    await seedProjectWithLead("proj-live-fail-down", "Downstream", 13)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))

    const res = await app.request(
      "/api/v2/projects/proj-live-fail-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-live-fail")),
        body: JSON.stringify({ sourceProjectId: "proj-live-fail-up", mode: "live" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { seeded: boolean }
    expect(body.seeded).toBe(false)
    fetchSpy.mockRestore()
  })

  // WHY: on the deployed environments identity and sync are routes on one
  // hostname, and Cloudflare does not deliver a plain fetch from one Worker to
  // another Worker's route on the same zone — only a service binding reaches
  // it (the AQU-2216 class; lib/sync-worker-fetch.ts). This trigger used the
  // URL, so the "awaited" first sync did not run there: links answered
  // `seeded: false`, "Choose files" adds answered `complete: false`, and a lead
  // was told their files "didn't finish arriving" on every confirm. Where a
  // binding is configured the trigger must use it and leave the URL alone.
  it("live: runs the seed sync through the SYNC_WORKER service binding when one is configured", async () => {
    await seedUser(14, "lead-live-binding")
    await seedProjectWithLead("proj-live-bind-up", "Upstream", 14)
    await seedProjectWithLead("proj-live-bind-down", "Downstream", 14)

    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const bindingCalls: Array<{ url: string; method?: string; authorization: string | null }> = []
    const SYNC_WORKER = {
      fetch: async (url: string, init?: RequestInit) => {
        bindingCalls.push({
          url,
          method: init?.method,
          authorization: new Headers(init?.headers).get("Authorization"),
        })
        return new Response(JSON.stringify({ ranSync: true, cellsMirrored: 2, filesMirrored: 1 }), { status: 200 })
      },
    }

    const res = await app.request(
      "/api/v2/projects/proj-live-bind-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-live-binding")),
        body: JSON.stringify({ sourceProjectId: "proj-live-bind-up", mode: "live" }),
      },
      { ...env, SYNC_WORKER },
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { seeded: boolean }).seeded).toBe(true)
    expect(bindingCalls).toHaveLength(1)
    expect(bindingCalls[0].url).toContain("/api/v1/projects/proj-live-bind-down/link/sync")
    expect(bindingCalls[0].method).toBe("POST")
    expect(bindingCalls[0].authorization).toMatch(/^Bearer .+/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  // WHY: the trigger is best-effort, and before this a non-2xx answer left no
  // trace at all — the fault above had to be pieced together from what was
  // MISSING in the logs. A trigger that does not land now says so, with the
  // status and the transport, and the route still reports `seeded: false` so
  // the client self-heals.
  it("live: a trigger the sync worker refuses is reported and logged with its status", async () => {
    await seedUser(15, "lead-live-refused")
    await seedProjectWithLead("proj-live-refused-up", "Upstream", 15)
    await seedProjectWithLead("proj-live-refused-down", "Downstream", 15)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const SYNC_WORKER = { fetch: async () => new Response("", { status: 522 }) }

    const res = await app.request(
      "/api/v2/projects/proj-live-refused-down/link-source",
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead-live-refused")),
        body: JSON.stringify({ sourceProjectId: "proj-live-refused-up", mode: "live" }),
      },
      { ...env, SYNC_WORKER },
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { seeded: boolean }).seeded).toBe(false)
    const logged = warnSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes("triggerLinkSeedSync"))
    expect(logged).toContain("HTTP 522")
    expect(logged).toContain("proj-live-refused-down")
    expect(logged).toContain("service binding")
    warnSpy.mockRestore()
  })
})
